const express = require('express');
const { body, query: queryValidator, validationResult } = require('express-validator');
const XMLService = require('../services/xmlService');
const SefinService = require('../services/sefinService');
const SefinResponseProcessor = require('../services/sefinResponseProcessor');
const { query } = require('../config/database');

const router = express.Router();

/**
 * Middleware para validar erros de validação
 */
function validarErros(req, res, next) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            sucesso: false,
            erro: 'Erro de validação',
            detalhes: errors.array()
        });
    }
    next();
}

/**
 * GET /api/nfse/parametros-convenio/:codigoMunicipio
 */
router.get('/parametros-convenio/:codigoMunicipio', async (req, res, next) => {
    try {
        const { codigoMunicipio } = req.params;
        const cnpjEmpresa = req.empresa.cnpj;
        
        if (!codigoMunicipio || codigoMunicipio.length !== 7) {
            return res.status(400).json({
                sucesso: false,
                erro: 'Código do município inválido (deve ter 7 dígitos)'
            });
        }
        
        console.log(`📋 Consultando parâmetros de convênio - Município: ${codigoMunicipio}`);
        
        const tipoAmbiente = req.empresa.tipo_ambiente;
        
        const resultado = await SefinService.consultarParametrosConvenio(
            codigoMunicipio,
            cnpjEmpresa,
            tipoAmbiente
        );
        
        if (!resultado.sucesso) {
            return res.status(resultado.status || 500).json({
                sucesso: false,
                erro: resultado.erro,
                detalhes: resultado.detalhes,
                mensagem: 'Não foi possível consultar os parâmetros do município'
            });
        }
        
        res.json({
            sucesso: true,
            codigoMunicipio,
            ambiente: tipoAmbiente === '1' ? 'Produção' : 'Homologação',
            parametros: resultado.dados,
            processamento: {
                tempoConsulta: `${resultado.tempoProcessamento}ms`,
                timestamp: new Date().toISOString()
            }
        });
        
    } catch (error) {
        console.error('❌ Erro ao consultar parâmetros:', error.message);
        next(error);
    }
});

/**
 * POST /api/nfse/emitir
 * COM TRATAMENTO DE DUPLICIDADE E MENSAGEM CLARA
 */
router.post('/emitir',
    [
        body('xml').notEmpty().withMessage('XML é obrigatório'),
        body('tipoAmbiente').optional().isIn(['1', '2']).withMessage('Tipo de ambiente inválido'),
    ],
    validarErros,
    async (req, res, next) => {
        const inicioProcessamento = Date.now();
        
        try {
            const { xml, tipoAmbiente } = req.body;
            const cnpjEmpresa = req.empresa.cnpj;
            const empresaId = req.empresa.id;
            
            console.log('\n' + '='.repeat(70));
            console.log(`📝 NOVA EMISSÃO - Empresa: ${req.empresa.razao_social}`);
            console.log('='.repeat(70));
            
            // 1. Processa o XML
            const resultado = await XMLService.processarXML(xml, cnpjEmpresa);
            const ambienteEnvio = tipoAmbiente || req.empresa.tipo_ambiente;
            
            // 2. Envia para SEFIN
            const respostaSefin = await SefinService.enviarDPS(
                resultado.dpsXmlGZipB64,
                cnpjEmpresa,
                ambienteEnvio
            );
            
            const tempoTotal = Date.now() - inicioProcessamento;
            const statusEnvio = respostaSefin.sucesso ? 'sucesso' : 'erro';
            
            // 3. Registra transmissão inicial
            const transmissaoId = await SefinService.registrarTransmissao({
                empresaId,
                idDPS: resultado.infoDPS.idDPS,
                numeroDPS: resultado.infoDPS.numeroDPS,
                serieDPS: resultado.infoDPS.serieDPS,
                xmlOriginal: xml,
                xmlAssinado: resultado.xmlAssinado,
                dpsBase64: resultado.dpsXmlGZipB64,
                statusEnvio,
                codigoRetorno: respostaSefin.dados?.codigo,
                mensagemRetorno: respostaSefin.dados?.mensagem,
                respostaCompleta: respostaSefin.dados,
                numeroProtocolo: respostaSefin.dados?.protocolo,
                dataRecebimento: respostaSefin.sucesso ? new Date() : null,
                ipOrigem: req.ip,
                userAgent: req.get('user-agent'),
                tempoProcessamento: tempoTotal
            });
            
            // =============================================
            // 4. VERIFICAÇÃO DE DUPLICIDADE (E0014)
            // =============================================
            let ehDuplicidadeRecuperavel = false;
            
            if (!respostaSefin.sucesso && respostaSefin.dados?.erros) {
                const erroE0014 = respostaSefin.dados.erros.find(e => 
                    e.Codigo === 'E0014' || e.Codigo === 'E174' || 
                    (e.Descricao && e.Descricao.includes('já existe'))
                );
                
                if (erroE0014) {
                    console.log('⚠️ Erro de Duplicidade detectado! Tentando recuperar nota existente...');
                    ehDuplicidadeRecuperavel = true;
                }
            }

            // =============================================
            // 5. PROCESSAMENTO OU RECUPERAÇÃO
            // =============================================
            let dadosNFSe = null;
            let mensagemUsuario = ''; // Variável para controlar a mensagem final
            
            if (respostaSefin.sucesso || ehDuplicidadeRecuperavel) {
                console.log('\n🔍 Processando resposta completa (ou recuperando duplicidade)...');
                
                if (ehDuplicidadeRecuperavel) {
                    // --- MODO RECUPERAÇÃO ---
                    console.log('🔧 Iniciando recuperação de nota duplicada...');
                    
                    // Busca a chave usando o ID da DPS
                    const consultaChave = await SefinResponseProcessor.consultarChaveAcesso(
                        resultado.infoDPS.idDPS,
                        cnpjEmpresa,
                        ambienteEnvio
                    );
                    
                    if (consultaChave.sucesso && consultaChave.chaveAcesso) {
                        // Simula sucesso para o processador
                        dadosNFSe = await SefinResponseProcessor.processarRespostaCompleta(
                            {
                                sucesso: true,
                                dados: {
                                    chaveAcesso: consultaChave.chaveAcesso,
                                    codigo: '100', 
                                    mensagem: 'Nota recuperada de duplicidade'
                                }
                            },
                            resultado.infoDPS,
                            cnpjEmpresa,
                            ambienteEnvio
                        );

                        // --- AQUI ESTÁ A CORREÇÃO DA MENSAGEM ---
                        mensagemUsuario = 'Nota Fiscal já constava na base de dados (Recuperada com sucesso)';
                        
                    } else {
                        dadosNFSe = { 
                            sucesso: false, 
                            mensagem: 'Erro de duplicidade: Nota existe mas não foi possível recuperar a chave.' 
                        };
                        mensagemUsuario = dadosNFSe.mensagem;
                    }
                } else {
                    // --- MODO NORMAL (PRIMEIRA EMISSÃO) ---
                    dadosNFSe = await SefinResponseProcessor.processarRespostaCompleta(
                        respostaSefin,
                        resultado.infoDPS,
                        cnpjEmpresa,
                        ambienteEnvio
                    );
                    
                    mensagemUsuario = dadosNFSe.mensagem || 'NFS-e emitida com sucesso';
                }
                
                // Atualiza banco se teve sucesso
                if (dadosNFSe && dadosNFSe.sucesso && dadosNFSe.chaveAcesso) {
                    await SefinResponseProcessor.atualizarTransmissaoComDadosNFSe(
                        transmissaoId,
                        dadosNFSe
                    );
                    
                    if (resultado.infoDPS.numeroDPS) {
                        await SefinService.atualizarUltimoNumeroDPS(
                            empresaId,
                            parseInt(resultado.infoDPS.numeroDPS)
                        );
                    }
                }
            } else {
                // Erro real
                dadosNFSe = {
                    sucesso: false,
                    mensagem: respostaSefin.dados?.mensagem || 'Erro no envio',
                    erros: respostaSefin.dados?.erros || []
                };
                mensagemUsuario = dadosNFSe.mensagem;
            }
            
            console.log('='.repeat(70));
            console.log(`✅ PROCESSO CONCLUÍDO - Tempo: ${tempoTotal}ms`);
            console.log('='.repeat(70) + '\n');
            
            // Resposta final
            res.status(dadosNFSe.sucesso ? 200 : 400).json({
                sucesso: dadosNFSe.sucesso,
                transmissaoId,
                dps: {
                    idDPS: resultado.infoDPS.idDPS,
                    numeroDPS: resultado.infoDPS.numeroDPS,
                    serieDPS: resultado.infoDPS.serieDPS
                },
                nfse: {
                    chaveAcesso: dadosNFSe.chaveAcesso,
                    numeroNFSe: dadosNFSe.numeroNFSe,
                    codigoVerificacao: dadosNFSe.codigoVerificacao,
                    linkConsulta: dadosNFSe.linkConsulta,
                    dataEmissao: dadosNFSe.dataEmissao,
                    situacao: dadosNFSe.situacao,
                    // xmlNFSe: dadosNFSe.xmlNFSe,
                    dpsLimpa: dadosNFSe.dpsLimpa 
                },
                sefin: {
                    protocolo: dadosNFSe.protocolo,
                    mensagem: mensagemUsuario, // ✨ Mensagem customizada aqui
                    erros: dadosNFSe.erros || null
                },
                processamento: {
                    tempoTotal: `${tempoTotal}ms`,
                    ambiente: ambienteEnvio === '1' ? 'Produção' : 'Homologação'
                },
                recuperadoDeDuplicidade: ehDuplicidadeRecuperavel
            });
            
        } catch (error) {
            console.error('❌ Erro na emissão:', error.message);
            try {
                const errorObj = JSON.parse(error.message);
                if (errorObj.tipo === 'VALIDACAO_XSD') {
                    return res.status(422).json({
                        sucesso: false,
                        tipo: 'validacao_xsd',
                        mensagem: errorObj.mensagem,
                        erros: errorObj.erros,
                        totalErros: errorObj.totalErros
                    });
                }
            } catch (e) {}
            
            next(error);
        }
    }
);

/**
 * POST /api/nfse/validar
 */
router.post('/validar',
    [
        body('xml').notEmpty().withMessage('XML é obrigatório')
    ],
    validarErros,
    async (req, res, next) => {
        try {
            const { xml } = req.body;
            const cnpjEmpresa = req.empresa.cnpj;
            
            console.log(`📋 Validando XML - Empresa: ${req.empresa.razao_social}`);
            
            const resultado = await XMLService.processarXML(xml, cnpjEmpresa);
            
            res.json({
                sucesso: true,
                mensagem: 'XML válido e pronto para envio',
                dps: {
                    idDPS: resultado.infoDPS.idDPS,
                    numeroDPS: resultado.infoDPS.numeroDPS,
                    serieDPS: resultado.infoDPS.serieDPS,
                    cnpjPrestador: resultado.infoDPS.cnpjPrestador,
                    cnpjTomador: resultado.infoDPS.cnpjTomador
                },
                validacao: resultado.validacao,
                debug: {
                    xmlAssinado: resultado.xmlAssinado,
                    tamanhoBase64: resultado.dpsXmlGZipB64.length
                }
            });
            
        } catch (error) {
            console.error('❌ Erro na validação:', error.message);
            try {
                const errorObj = JSON.parse(error.message);
                if (errorObj.tipo === 'VALIDACAO_XSD') {
                    return res.status(422).json({
                        sucesso: false,
                        tipo: 'validacao_xsd',
                        mensagem: errorObj.mensagem,
                        erros: errorObj.erros,
                        totalErros: errorObj.totalErros
                    });
                }
            } catch (e) {}
            next(error);
        }
    }
);

/**
 * GET /api/nfse/consultar-por-chave/:chaveAcesso
 * Retorna dados + PDF Base64 para anexo de e-mail
 */
router.get('/consultar-por-chave/:chaveAcesso', async (req, res, next) => {
    try {
        const { chaveAcesso } = req.params;
        const cnpjEmpresa = req.empresa.cnpj;
        const tipoAmbiente = req.empresa.tipo_ambiente;
        
        console.log(`🔍 Consultando NFS-e: ${chaveAcesso.substring(0, 20)}...`);
        
        if (!chaveAcesso || chaveAcesso.length < 44) {
            return res.status(400).json({
                sucesso: false,
                erro: 'Chave de acesso inválida'
            });
        }
        
        // 1. Consulta dados da NFS-e
        const resultado = await SefinResponseProcessor.consultarDadosNFSe(
            chaveAcesso,
            cnpjEmpresa,
            tipoAmbiente
        );
        
        if (!resultado.sucesso) {
            return res.status(404).json({
                sucesso: false,
                erro: 'NFS-e não encontrada',
                detalhes: resultado.erro
            });
        }
        
        // 2. Extrai DPS limpa
        let dpsLimpa = null;
        if (resultado.xmlNFSe) {
            const XMLExtractor = require('../utils/xmlExtractor');
            try {
                dpsLimpa = XMLExtractor.extrairDPSLimpa(resultado.xmlNFSe);
            } catch (error) {
                console.warn('Erro ao extrair DPS limpa:', error.message);
            }
        }
        
        // 3. Baixa PDF em Base64 (para anexo de e-mail)
        const incluirPDF = req.query.incluirPDF !== 'false'; // Padrão: true
        let pdfResult = { sucesso: false };
        
        if (incluirPDF) {
            pdfResult = await SefinResponseProcessor.baixarPDFBase64(
                chaveAcesso,
                cnpjEmpresa,
                tipoAmbiente
            );
        }
        
        // 4. Monta URLs
        const baseURL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
        
        res.json({
            sucesso: true,
            nfse: {
                chaveAcesso: chaveAcesso,
                numeroNFSe: resultado.numeroNFSe,
                codigoVerificacao: resultado.codigoVerificacao,
                dataEmissao: resultado.dataEmissao,
                situacao: resultado.situacao,
                
                // 📄 PDF para anexo de e-mail (snapshot do momento da consulta)
                pdfBase64: pdfResult.sucesso ? pdfResult.pdfBase64 : null,
                pdfTamanhoKB: pdfResult.sucesso ? pdfResult.tamanhoKB : null,
                pdfErro: !pdfResult.sucesso ? pdfResult.erro : null,
                
                // 🔗 Links oficiais SEFIN (sempre atualizados, mas precisam certificado)
                linksOficiais: {
                    consulta: SefinResponseProcessor.montarLinkConsulta(chaveAcesso, tipoAmbiente),
                    pdf: SefinResponseProcessor.montarLinkPDF(chaveAcesso, tipoAmbiente),
                    aviso: "⚠️ Requer certificado digital instalado no navegador"
                },
                
                // 🔄 Links proxy pela sua API (usa certificado automaticamente)
                linksProxy: {
                    pdf: `${baseURL}/api/nfse/pdf/${chaveAcesso}`,
                    aviso: "✅ Funciona em qualquer navegador (usa certificado da API)"
                },
                
                // 📦 XMLs
                // xmlNFSe: resultado.xmlNFSe,
                dpsLimpa: dpsLimpa,
                
                // ⚠️ AVISO IMPORTANTE
                avisoStatus: "⚠️ O status 'situacao' pode estar desatualizado se a nota foi cancelada após esta consulta. Use os links oficiais para verificar a situação atual."
            },
            // dadosCompletos: resultado.dadosCompletos
        });
        
    } catch (error) {
        console.error('❌ Erro ao consultar NFS-e:', error.message);
        next(error);
    }
});

/**
 * GET /api/nfse/pdf/:chaveAcesso
 * Download direto do PDF (para visualizar no navegador)
 */
router.get('/pdf/:chaveAcesso', async (req, res, next) => {
    try {
        const { chaveAcesso } = req.params;
        const cnpjEmpresa = req.empresa.cnpj;
        const tipoAmbiente = req.empresa.tipo_ambiente;
        
        if (!chaveAcesso || chaveAcesso.length < 44) {
            return res.status(400).json({
                sucesso: false,
                erro: 'Chave de acesso inválida'
            });
        }
        
        const CertificadoService = require('../services/certificadoService');
        const certInfo = await CertificadoService.buscarCertificadoPorCNPJ(cnpjEmpresa);
        
        const { privateKeyPem, certificatePem } = 
            CertificadoService.extrairCertificadoPEM(
                certInfo.certificadoBuffer,
                certInfo.senha
            );
        
        const https = require('https');
        const axios = require('axios');
        const httpsAgent = new https.Agent({
            cert: certificatePem,
            key: privateKeyPem,
            rejectUnauthorized: tipoAmbiente === '1'
        });
        
        const urlBase = tipoAmbiente === '1'
            ? 'https://adn.producao.nfse.gov.br'
            : 'https://adn.producaorestrita.nfse.gov.br';
        
        const urlPDF = `${urlBase}/danfse/${chaveAcesso}`;
        
        const response = await axios.get(urlPDF, {
            httpsAgent: httpsAgent,
            responseType: 'arraybuffer',
            timeout: 30000
        });
        
        // inline = visualiza no navegador | attachment = força download
        const disposition = req.query.download === 'true' ? 'attachment' : 'inline';
        
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `${disposition}; filename="NFSe-${chaveAcesso}.pdf"`);
        res.send(response.data);
        
    } catch (error) {
        console.error('❌ Erro ao baixar PDF:', error.message);
        
        if (error.response?.status === 404) {
            return res.status(404).json({
                sucesso: false,
                erro: 'PDF não encontrado'
            });
        }
        
        next(error);
    }
});

/**
 * GET /api/nfse/consultar/:idDPS
 */
router.get('/consultar/:idDPS', async (req, res, next) => {
    try {
        const { idDPS } = req.params;
        const cnpjEmpresa = req.empresa.cnpj;
        
        const transmissao = await SefinService.consultarTransmissao(idDPS, cnpjEmpresa);
        
        if (!transmissao) {
            return res.status(404).json({
                sucesso: false,
                erro: 'Transmissão não encontrada'
            });
        }
        
        res.json({
            sucesso: true,
            transmissao: {
                id: transmissao.id,
                idDPS: transmissao.id_dps,
                numeroDPS: transmissao.numero_dps,
                serieDPS: transmissao.serie_dps,
                status: transmissao.status_envio,
                protocolo: transmissao.numero_protocolo,
                dataEnvio: transmissao.created_at,
                dataRecebimento: transmissao.data_recebimento,
                nfse: {
                    chaveAcesso: transmissao.chave_acesso_nfse,
                    numeroNFSe: transmissao.numero_nfse,
                    codigoVerificacao: transmissao.codigo_verificacao,
                    linkConsulta: transmissao.link_consulta,
                    dataEmissao: transmissao.data_emissao_nfse,
                    situacao: transmissao.situacao_nfse
                },
                resposta: transmissao.resposta_completa
            }
        });
        
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/nfse/listar
 */
router.get('/listar',
    [
        queryValidator('pagina').optional().isInt({ min: 1 }).toInt(),
        queryValidator('limite').optional().isInt({ min: 1, max: 100 }).toInt()
    ],
    validarErros,
    async (req, res, next) => {
        try {
            const pagina = req.query.pagina || 1;
            const limite = req.query.limite || 20;
            const cnpjEmpresa = req.empresa.cnpj;
            
            const resultado = await SefinService.listarTransmissoes(
                cnpjEmpresa,
                pagina,
                limite
            );
            
            res.json({
                sucesso: true,
                ...resultado
            });
            
        } catch (error) {
            next(error);
        }
    }
);

/**
 * GET /api/nfse/status
 */
router.get('/status', async (req, res, next) => {
    try {
        const sql = `
            SELECT 
                cnpj,
                razao_social,
                codigo_municipio,
                ultimo_numero_dps,
                serie_dps,
                tipo_ambiente,
                certificado_validade,
                DATEDIFF(certificado_validade, CURDATE()) as dias_restantes_certificado
            FROM empresas
            WHERE id = ?
        `;
        
        const results = await query(sql, [req.empresa.id]);
        const empresa = results[0];
        
        res.json({
            sucesso: true,
            empresa: {
                cnpj: empresa.cnpj,
                razaoSocial: empresa.razao_social,
                codigoMunicipio: empresa.codigo_municipio,
                ambiente: empresa.tipo_ambiente === '1' ? 'Produção' : 'Homologação',
                numeracao: {
                    serie: empresa.serie_dps,
                    ultimoNumero: empresa.ultimo_numero_dps,
                    proximoNumero: empresa.ultimo_numero_dps + 1
                },
                certificado: {
                    validade: empresa.certificado_validade,
                    diasRestantes: empresa.dias_restantes_certificado,
                    status: empresa.dias_restantes_certificado > 30 ? 'válido' : 'próximo do vencimento'
                }
            }
        });
        
    } catch (error) {
        next(error);
    }
});

module.exports = router;