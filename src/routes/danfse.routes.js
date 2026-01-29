const express = require('express');
const router = express.Router();
const DanfseService = require('../services/danfseService');
const DanfseDataHelper = require('../helpers/danfseDataHelper');
const SefinResponseProcessor = require('../services/sefinResponseProcessor');

function montarDadosEmpresa(req) {
    return {
        cnpj: req.empresa.cnpj,
        razao_social: req.empresa.razao_social,
        inscricao_municipal: req.empresa.inscricao_municipal,
        telefone: req.empresa.telefone,
        email: req.empresa.email,
        logradouro: req.empresa.logradouro,
        numero: req.empresa.numero,
        complemento: req.empresa.complemento,
        bairro: req.empresa.bairro,
        municipio: req.empresa.municipio,
        uf: req.empresa.uf,
        cep: req.empresa.cep,
        codigo_municipio: req.empresa.codigo_municipio,
        optante_simples: req.empresa.optante_simples,
        regime_apuracao: req.empresa.regime_apuracao
    };
}


router.post('/gerar', async (req, res, next) => {
    try {
        // ✅ Valores padrão para isCancelled e isSubst
        const { dados, xml, chaveAcesso, chave } = req.body;
        const isCancelled = req.body.isCancelled === true;
        const isSubst = req.body.isSubst === true;

        console.log('\n' + '='.repeat(70));
        console.log(`📄 GERAR DANFSE - Empresa: ${req.empresa.razao_social}`);
        console.log('='.repeat(70));

        let dadosDanfse;

        // OPÇÃO 1: JSON MANUAL
        if (dados) {
            console.log('📋 Modo: JSON Manual');
            dadosDanfse = dados;
        }
        // OPÇÃO 2: XML (extração automática)
        else if (xml) {
            console.log('📄 Modo: XML da NFSe');

            const dadosEmpresa = montarDadosEmpresa(req);
            dadosDanfse = await DanfseDataHelper.converterXMLParaDanfse(xml, dadosEmpresa);
            
            console.log(`   Chave: ${dadosDanfse.ChaveAcesso}`);
            console.log(`   Número: ${dadosDanfse.NumeroNfse}`);
        }
        // OPÇÃO 3: CHAVE DE ACESSO (busca XML na SEFIN)
        else if (chaveAcesso || chave) {
            const chaveInformada = (chaveAcesso || chave || '').trim();
            console.log(`🔎 Modo: Chave de acesso (${chaveInformada.substring(0, 20)}...)`);

            if (!chaveInformada || chaveInformada.length !== 50) {
                return res.status(400).json({
                    sucesso: false,
                    erro: 'Chave de acesso inválida (deve ter 50 caracteres)',
                    recebido: chaveInformada?.length || 0
                });
            }

            const resultado = await SefinResponseProcessor.consultarDadosNFSe(
                chaveInformada,
                req.empresa.cnpj
            );

            if (!resultado.sucesso) {
                return res.status(404).json({
                    sucesso: false,
                    erro: 'NFS-e não encontrada',
                    detalhes: resultado.erro
                });
            }

            if (!resultado.xmlNFSe) {
                return res.status(404).json({
                    sucesso: false,
                    erro: 'XML da NFS-e não disponível',
                    mensagem: 'A nota foi encontrada mas o XML ainda não está disponível para download'
                });
            }

            const dadosEmpresa = montarDadosEmpresa(req);
            dadosDanfse = await DanfseDataHelper.converterXMLParaDanfse(
                resultado.xmlNFSe,
                dadosEmpresa
            );

            console.log(`   Chave: ${dadosDanfse.ChaveAcesso}`);
            console.log(`   Número: ${dadosDanfse.NumeroNfse}`);
        }
        else {
            return res.status(400).json({
                sucesso: false,
                erro: 'Forneça "dados" (JSON) OU "xml" (XML da NFSe) OU "chaveAcesso"',
                dica: 'GET /api/danfse/exemplo para ver exemplos'
            });
        }

        console.log(`   🏷️ Tipo: ${isSubst ? 'Substituída' : isCancelled ? 'Cancelada' : 'Normal'}`);

        // Gera o DANFSE
        const pdfBuffer = await DanfseService.gerar(
            dadosDanfse,
            isCancelled,
            isSubst
        );

        // Retorna PDF
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="DANFSE-${dadosDanfse.ChaveAcesso || 'documento'}.pdf"`);
        res.send(pdfBuffer);

        console.log('✅ DANFSE gerado com sucesso!');

    } catch (error) {
        console.error('❌ Erro ao gerar DANFSE:', error);
        next(error);
    }
});

/**
 * GET /api/danfse/:chave/pdf
 * Gera DANFSE a partir da chave de acesso (consulta XML na SEFIN)
 *
 * Query params:
 *   - isCancelled=true|false
 *   - isSubst=true|false
 */
router.get('/:chave/pdf', async (req, res, next) => {
    try {
        const { chave } = req.params;
        const isCancelled = req.query.isCancelled === 'true' || req.query.isCancelled === '1';
        const isSubst = req.query.isSubst === 'true' || req.query.isSubst === '1';

        console.log('\n' + '='.repeat(70));
        console.log(`📄 GERAR DANFSE (CHAVE) - Empresa: ${req.empresa.razao_social}`);
        console.log('='.repeat(70));

        if (!chave || chave.length !== 50) {
            return res.status(400).json({
                sucesso: false,
                erro: 'Chave de acesso inválida (deve ter 50 caracteres)',
                recebido: chave?.length || 0
            });
        }

        const resultado = await SefinResponseProcessor.consultarDadosNFSe(
            chave,
            req.empresa.cnpj
        );

        if (!resultado.sucesso) {
            return res.status(404).json({
                sucesso: false,
                erro: 'NFS-e não encontrada',
                detalhes: resultado.erro
            });
        }

        if (!resultado.xmlNFSe) {
            return res.status(404).json({
                sucesso: false,
                erro: 'XML da NFS-e não disponível',
                mensagem: 'A nota foi encontrada mas o XML ainda não está disponível para download'
            });
        }

        const dadosEmpresa = montarDadosEmpresa(req);
        const dadosDanfse = await DanfseDataHelper.converterXMLParaDanfse(
            resultado.xmlNFSe,
            dadosEmpresa
        );

        console.log(`   Chave: ${dadosDanfse.ChaveAcesso}`);
        console.log(`   Número: ${dadosDanfse.NumeroNfse}`);
        console.log(`   🏷️ Tipo: ${isSubst ? 'Substituída' : isCancelled ? 'Cancelada' : 'Normal'}`);

        const pdfBuffer = await DanfseService.gerar(
            dadosDanfse,
            isCancelled,
            isSubst
        );

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="DANFSE-${dadosDanfse.ChaveAcesso || chave}.pdf"`);
        res.send(pdfBuffer);

        console.log('✅ DANFSE gerado com sucesso!');

    } catch (error) {
        console.error('❌ Erro ao gerar DANFSE pela chave:', error);
        next(error);
    }
});

/**
 * POST /api/danfse/lote
 * Gera múltiplos DANFSEs (JSON ou XML)
 */
router.post('/lote', async (req, res, next) => {
    try {
        const { dadosArray, xmlArray, isCancelled, isSubst } = req.body;

        console.log('\n' + '='.repeat(70));
        console.log(`📚 LOTE DANFSE - Empresa: ${req.empresa.razao_social}`);
        console.log('='.repeat(70));

        let dadosParaGerar = [];

        if (dadosArray && Array.isArray(dadosArray)) {
            console.log(`📋 ${dadosArray.length} JSONs`);
            dadosParaGerar = dadosArray;
        }
        else if (xmlArray && Array.isArray(xmlArray)) {
            console.log(`📄 ${xmlArray.length} XMLs`);
            const dadosEmpresa = montarDadosEmpresa(req);

            for (const xml of xmlArray) {
                try {
                    const dados = await DanfseDataHelper.converterXMLParaDanfse(xml, dadosEmpresa);
                    dadosParaGerar.push(dados);
                } catch (error) {
                    console.error('⚠️ Erro XML:', error.message);
                }
            }
        }
        else {
            return res.status(400).json({
                sucesso: false,
                erro: 'Forneça "dadosArray" (JSONs) OU "xmlArray" (XMLs)'
            });
        }

        if (dadosParaGerar.length === 0) {
            return res.status(400).json({
                sucesso: false,
                erro: 'Nenhum dado válido'
            });
        }

        if (dadosParaGerar.length > 50) {
            return res.status(400).json({
                sucesso: false,
                erro: 'Máximo 50 notas por lote'
            });
        }

        const pdfsGerados = [];
        const erros = [];

        for (let i = 0; i < dadosParaGerar.length; i++) {
            try {
                const pdfBuffer = await DanfseService.gerar(
                    dadosParaGerar[i],
                    isCancelled || false,
                    isSubst || false
                );
                pdfsGerados.push(pdfBuffer);
            } catch (error) {
                erros.push({ 
                    indice: i, 
                    chave: dadosParaGerar[i]?.ChaveAcesso,
                    erro: error.message 
                });
            }
        }

        if (pdfsGerados.length === 0) {
            return res.status(400).json({
                sucesso: false,
                erro: 'Nenhum DANFSE gerado',
                erros
            });
        }

        const pdfFinal = await DanfseService.concatenarPdfs(...pdfsGerados);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="DANFSE-Lote-${Date.now()}.pdf"`);
        res.send(pdfFinal);

        console.log(`✅ ${pdfsGerados.length} DANFSEs, ${erros.length} erros`);

    } catch (error) {
        console.error('❌ Erro lote:', error);
        next(error);
    }
});

/**
 * GET /api/danfse/exemplo
 * Exemplos de uso
 */
router.get('/exemplo', (req, res) => {
    res.json({
        mensagem: 'API DANFSE - Aceita JSON ou XML',
        
        gerar_individual: {
            rota: 'POST /api/danfse/gerar',
            
            opcao1_json: {
                dados: {
                    ChaveAcesso: "33033022209443542000103000000000003126010759590277",
                    NumeroNfse: "31",
                    NumeroDps: "31",
                    SerieDps: "00001",
                    CnpjPrestador: "09443542000103",
                    NomePrestador: "SERVICOS DE PRATICAGEM NEW PILOTS LTDA",
                    cMunicipioPrestador: "3303302",
                    DocumentoTomador: "05429268000167",
                    NomeTomador: "ISS MARINE SERVICES LTDA",
                    ValorServico: 118216.00,
                    BaseCalculoIssqn: 118216.00,
                    Aliquota: 5.00,
                    IssqnApurado: 5910.80,
                    ValorLiquido: 105034.92,
                    ValorIrrf: 1773.24,
                    ValorCsll: 1182.16,
                    ValorPis: 768.40,
                    ValorCofins: 3546.48,
                    TotalTributosFederais: 7270.28,
                    DescontoIncondicionado: 0,
                    DescontoCondicionado: 0,
                    TotalDeducoes: 0,
                    IssqnRetido: 0,
                    PisCofinsRetidos: 4314.88,
                    TotalTributacaoFederal: 7270.28,
                    TotalTributosEstaduais: 0,
                    TotalTributosMunicipais: 5910.80
                },
                isCancelled: false,
                isSubst: false
            },
            
            opcao2_xml: {
                xml: '<?xml version="1.0" encoding="utf-8"?><NFSe>...</NFSe>',
                isCancelled: false,
                isSubst: false
            },

            opcao3_chave: {
                chaveAcesso: "33033022209443542000103000000000003126010759590277",
                isCancelled: false,
                isSubst: false
            }
        },

        gerar_por_chave: {
            rota: 'GET /api/danfse/:chave/pdf',
            exemplo: '/api/danfse/33033022209443542000103000000000003126010759590277/pdf'
        },
        
        gerar_lote: {
            rota: 'POST /api/danfse/lote',
            
            opcao1: {
                dadosArray: [
                    { ChaveAcesso: "123...", NumeroNfse: "1" },
                    { ChaveAcesso: "456...", NumeroNfse: "2" }
                ]
            },
            
            opcao2: {
                xmlArray: [
                    '<?xml version="1.0"?><NFSe>...</NFSe>',
                    '<?xml version="1.0"?><NFSe>...</NFSe>'
                ]
            }
        }
    });
});

module.exports = router;
