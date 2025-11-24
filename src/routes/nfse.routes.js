const express = require('express');
const { body, query: queryValidator, validationResult } = require('express-validator');
const XMLService = require('../services/xmlService');
const SefinService = require('../services/sefinService');
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
 * Consulta os parâmetros de convênio de um município
 */
router.get('/parametros-convenio/:codigoMunicipio', async (req, res, next) => {
    try {
        const { codigoMunicipio } = req.params;
        const cnpjEmpresa = req.empresa.cnpj;
        
        // Validação do código do município (7 dígitos IBGE)
        if (!codigoMunicipio || codigoMunicipio.length !== 7) {
            return res.status(400).json({
                sucesso: false,
                erro: 'Código do município inválido (deve ter 7 dígitos)'
            });
        }
        
        console.log(`📋 Consultando parâmetros de convênio - Município: ${codigoMunicipio}`);
        
        // Define ambiente (usa da empresa)
        const tipoAmbiente = req.empresa.tipo_ambiente;
        
        // Consulta parâmetros na ADN
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
 * Emite uma NFS-e processando o XML enviado
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
            
            // Processa o XML (valida, assina, comprime)
            const resultado = await XMLService.processarXML(xml, cnpjEmpresa);
            
            // Define ambiente (usa da empresa se não especificado)
            const ambienteEnvio = tipoAmbiente || req.empresa.tipo_ambiente;
            
            // Envia para SEFIN
            const respostaSefin = await SefinService.enviarDPS(
                resultado.dpsXmlGZipB64,
                cnpjEmpresa,
                ambienteEnvio
            );
            
            const tempoTotal = Date.now() - inicioProcessamento;
            
            // Determina status
            const statusEnvio = respostaSefin.sucesso ? 'sucesso' : 'erro';
            
            // Registra transmissão
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
            
            // Atualiza último número DPS se sucesso
            if (respostaSefin.sucesso && resultado.infoDPS.numeroDPS) {
                await SefinService.atualizarUltimoNumeroDPS(
                    empresaId,
                    parseInt(resultado.infoDPS.numeroDPS)
                );
            }
            
            console.log('='.repeat(70));
            console.log(`✅ EMISSÃO CONCLUÍDA - Tempo: ${tempoTotal}ms`);
            console.log('='.repeat(70) + '\n');
            
            // Resposta
            res.status(respostaSefin.sucesso ? 200 : 400).json({
                sucesso: respostaSefin.sucesso,
                transmissaoId,
                dps: {
                    idDPS: resultado.infoDPS.idDPS,
                    numeroDPS: resultado.infoDPS.numeroDPS,
                    serieDPS: resultado.infoDPS.serieDPS
                },
                sefin: {
                    status: respostaSefin.status,
                    protocolo: respostaSefin.dados?.protocolo,
                    mensagem: respostaSefin.dados?.mensagem,
                    erros: respostaSefin.dados?.erros || null
                },
                processamento: {
                    tempoTotal: `${tempoTotal}ms`,
                    ambiente: ambienteEnvio === '1' ? 'Produção' : 'Homologação'
                },
                validacao: resultado.validacao, // ← NOVO: Informações de validação
                // Dados completos em desenvolvimento
                ...(process.env.NODE_ENV !== 'production' && {
                    debug: {
                        xmlAssinado: resultado.xmlAssinado,
                        dpsBase64: resultado.dpsXmlGZipB64,
                        respostaCompletaSefin: respostaSefin.dados
                    }
                })
            });
            
        } catch (error) {
            console.error('❌ Erro na emissão:', error.message);
            
            // ============================================
            // TRATAMENTO ESPECIAL PARA ERROS DE VALIDAÇÃO XSD
            // ============================================
            try {
                const errorObj = JSON.parse(error.message);
                if (errorObj.tipo === 'VALIDACAO_XSD') {
                    console.log('  ⚠️  Erro de validação XSD detectado');
                    console.log(`  ⚠️  Total de erros: ${errorObj.totalErros}`);
                    
                    return res.status(422).json({
                        sucesso: false,
                        tipo: 'validacao_xsd',
                        mensagem: errorObj.mensagem,
                        erros: errorObj.erros,
                        totalErros: errorObj.totalErros,
                        ajuda: 'Corrija os erros no XML antes de enviar novamente',
                        documentacao: '/api/docs'
                    });
                }
            } catch (e) {
                // Não é um erro de validação XSD estruturado
                // Continua para o handler geral de erros
            }
            
            next(error);
        }
    }
);

/**
 * POST /api/nfse/validar
 * Valida o XML sem enviar para SEFIN
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
            
            // Processa o XML sem enviar
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
                validacao: resultado.validacao, // ← NOVO: Informações de validação
                debug: {
                    xmlAssinado: resultado.xmlAssinado,
                    tamanhoBase64: resultado.dpsXmlGZipB64.length
                }
            });
            
        } catch (error) {
            console.error('❌ Erro na validação:', error.message);
            
            // ============================================
            // TRATAMENTO ESPECIAL PARA ERROS DE VALIDAÇÃO XSD
            // ============================================
            try {
                const errorObj = JSON.parse(error.message);
                if (errorObj.tipo === 'VALIDACAO_XSD') {
                    console.log('  ⚠️  Erro de validação XSD detectado');
                    console.log(`  ⚠️  Total de erros: ${errorObj.totalErros}`);
                    
                    return res.status(422).json({
                        sucesso: false,
                        tipo: 'validacao_xsd',
                        mensagem: errorObj.mensagem,
                        erros: errorObj.erros,
                        totalErros: errorObj.totalErros,
                        ajuda: 'Corrija os erros no XML antes de enviar novamente',
                        documentacao: '/api/docs'
                    });
                }
            } catch (e) {
                // Não é um erro de validação XSD estruturado
                // Continua para o handler geral de erros
            }
            
            next(error);
        }
    }
);

/**
 * GET /api/nfse/consultar/:idDPS
 * Consulta uma transmissão pelo ID da DPS
 */
router.get('/consultar/:idDPS',
    async (req, res, next) => {
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
                    resposta: transmissao.resposta_completa
                }
            });
            
        } catch (error) {
            next(error);
        }
    }
);

/**
 * GET /api/nfse/listar
 * Lista transmissões com paginação
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
 * Status da empresa e última numeração
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