const axios = require('axios');
const https = require('https');
const zlib = require('zlib');
const { query } = require('../config/database');
const CertificadoService = require('./certificadoService');
const XMLExtractor = require('../utils/xmlExtractor');

/**
 * Service para processar resposta completa da SEFIN
 */
class SefinResponseProcessor {

    /**
     * Descomprime Base64 GZIP para XML
     */
    static decodificarEDescomprimir(base64String) {
        try {
            const compressed = Buffer.from(base64String, 'base64');
            const decompressed = zlib.gunzipSync(compressed);
            return decompressed.toString('utf-8');
        } catch (error) {
            throw new Error(`Erro ao descomprimir XML: ${error.message}`);
        }
    }

    /**
     * Aguardar X milissegundos
     */
    static aguardar(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Processa resposta completa após emissão da DPS
     */
    static async processarRespostaCompleta(respostaSefin, infoDPS, cnpjEmpresa, tipoAmbiente) {
        try {
            console.log('\n📊 Processando resposta completa da SEFIN...');

            const resultado = {
                sucesso: false,
                protocolo: null,
                chaveAcesso: null,
                numeroNFSe: null,
                codigoVerificacao: null,
                linkConsulta: null,
                dataEmissao: null,
                situacao: null,
                xmlNFSe: null,
                dpsLimpa: null,
                mensagem: null,
                erros: [],
                statusProcessamento: null
            };

            if (!respostaSefin.sucesso) {
                resultado.mensagem = 'Erro ao enviar DPS para a SEFIN';
                resultado.erros = respostaSefin.dados?.erros || [respostaSefin.erro];
                resultado.statusProcessamento = 'ERRO_ENVIO';
                return resultado;
            }

            const dadosSefin = respostaSefin.dados;
            resultado.protocolo = dadosSefin.protocolo || dadosSefin.numeroProtocolo;
            resultado.chaveAcesso = dadosSefin.chaveAcesso;

            console.log(`   → Protocolo: ${resultado.protocolo}`);
            console.log(`   → Chave de Acesso: ${resultado.chaveAcesso || 'Não disponível ainda'}`);

            const codigoRetorno = dadosSefin.codigo ? String(dadosSefin.codigo) : String(dadosSefin.codigoRetorno || '');
            
            if (codigoRetorno === '100') {
                console.log('   ✅ DPS AUTORIZADA!');
                resultado.statusProcessamento = 'AUTORIZADA';
                resultado.sucesso = true;
            } else if (codigoRetorno === '105') {
                console.log('   ⏳ DPS PENDENTE DE PROCESSAMENTO');
                resultado.statusProcessamento = 'PENDENTE';
                resultado.sucesso = true;
                resultado.mensagem = 'DPS recebida e está sendo processada pela SEFIN';
                console.log('   → Aguardando 5 segundos...');
                await this.aguardar(5000);
            } else {
                if (resultado.chaveAcesso) {
                    console.warn(`   ⚠️ Código atípico (${codigoRetorno}), mas com Chave. Forçando sucesso.`);
                    resultado.statusProcessamento = 'AUTORIZADA';
                    resultado.sucesso = true;
                    resultado.mensagem = dadosSefin.mensagem || 'DPS processada (código atípico)';
                } else {
                    console.log(`   ❌ DPS REJEITADA - Código: ${codigoRetorno}`);
                    resultado.mensagem = dadosSefin.mensagem || 'DPS rejeitada';
                    resultado.erros = dadosSefin.erros || [];
                    resultado.statusProcessamento = 'REJEITADA';
                    resultado.sucesso = false;
                    return resultado;
                }
            }

            let tentativas = 0;
            const maxTentativas = 3;
            
            while (!resultado.chaveAcesso && tentativas < maxTentativas) {
                tentativas++;
                if (tentativas > 1) {
                    console.log(`   → Tentativa ${tentativas}/${maxTentativas}...`);
                    await this.aguardar(3000 * tentativas);
                }

                const chaveResult = await this.consultarChaveAcesso(infoDPS.idDPS, cnpjEmpresa, tipoAmbiente);

                if (chaveResult.sucesso) {
                    resultado.chaveAcesso = chaveResult.chaveAcesso;
                    console.log(`   ✓ Chave obtida: ${resultado.chaveAcesso}`);
                    break;
                }
            }

            if (!resultado.chaveAcesso) {
                if (resultado.statusProcessamento === 'PENDENTE') {
                    console.log('   ⚠️  Chave ainda não disponível');
                    resultado.sucesso = true;
                    resultado.mensagem = 'DPS aceita. Consulte novamente em breve.';
                    return resultado;
                }
                console.log('   ❌ Não foi possível obter chave');
                resultado.mensagem = 'DPS enviada mas chave indisponível';
                resultado.statusProcessamento = 'SEM_CHAVE';
                resultado.sucesso = false;
                return resultado;
            }

            console.log('   → Consultando NFS-e completa...');
            
            const dadosNFSeResult = await this.consultarDadosNFSe(resultado.chaveAcesso, cnpjEmpresa, tipoAmbiente);

            if (dadosNFSeResult.sucesso) {
                resultado.numeroNFSe = dadosNFSeResult.numeroNFSe;
                resultado.codigoVerificacao = dadosNFSeResult.codigoVerificacao;
                resultado.dataEmissao = dadosNFSeResult.dataEmissao;
                resultado.situacao = dadosNFSeResult.situacao;
                resultado.dadosCompletos = dadosNFSeResult.dadosCompletos;
                
                if (dadosNFSeResult.nfseXmlGZipB64) {
                    console.log('   → Descomprimindo XML...');
                    try {
                        resultado.xmlNFSe = this.decodificarEDescomprimir(dadosNFSeResult.nfseXmlGZipB64);
                        console.log('   ✓ XML descomprimido!');
                        
                        // Extrai DPS limpa (sem correção de encoding)
                        try {
                            resultado.dpsLimpa = XMLExtractor.extrairDPSLimpa(resultado.xmlNFSe);
                            console.log('   ✓ DPS limpa extraída!');
                        } catch (error) {
                            console.error('   ✗ Erro ao extrair DPS:', error.message);
                        }
                        
                    } catch (error) {
                        console.warn(`   ⚠️  Erro ao descomprimir: ${error.message}`);
                    }
                }
                
                console.log(`   ✓ Número NFS-e: ${resultado.numeroNFSe || 'Ainda não disponível'}`);
                
                if (resultado.situacao === 'Pendente' || resultado.situacao === 'Em processamento') {
                    resultado.statusProcessamento = 'PROCESSANDO';
                    resultado.mensagem = 'NFS-e aceita e em processamento.';
                } else {
                    resultado.sucesso = true;
                    resultado.statusProcessamento = 'CONCLUIDA';
                    resultado.mensagem = 'NFS-e emitida com sucesso';
                }
            } else {
                console.log('   ⚠️  Dados completos indisponíveis');
                resultado.sucesso = true;
                resultado.statusProcessamento = 'AGUARDANDO_DADOS';
                resultado.mensagem = 'DPS aceita. Dados completos em breve.';
            }

            resultado.linkConsulta = this.montarLinkConsulta(resultado.chaveAcesso, tipoAmbiente);

            console.log('✅ Processamento completo!\n');
            console.log(`   Status final: ${resultado.statusProcessamento}`);
            
            return resultado;

        } catch (error) {
            console.error('❌ Erro ao processar:', error.message);
            return {
                sucesso: false,
                mensagem: `Erro no processamento: ${error.message}`,
                erros: [error.message],
                statusProcessamento: 'ERRO_INTERNO'
            };
        }
    }

/**
 * Consulta dados completos da NFS-e autorizada
 */
static async consultarDadosNFSe(chaveAcesso, cnpjEmpresa, tipoAmbiente) {
    try {
        console.log(`   → Consultando NFS-e...`);

        const certInfo = await CertificadoService.buscarCertificadoPorCNPJ(cnpjEmpresa);
        
        const { privateKeyPem, certificatePem } = 
            CertificadoService.extrairCertificadoPEM(
                certInfo.certificadoBuffer,
                certInfo.senha
            );

        const httpsAgent = new https.Agent({
            cert: certificatePem,
            key: privateKeyPem,
            rejectUnauthorized: tipoAmbiente === '1'
        });

        const urlSefin = tipoAmbiente === '1'
            ? 'https://sefin.producao.nfse.gov.br'
            : 'https://sefin.producaorestrita.nfse.gov.br';

        const urlCompleta = `${urlSefin}/SefinNacional/nfse/${chaveAcesso}`;

        const response = await axios.get(urlCompleta, {
            headers: { 'Accept': 'application/json' },
            httpsAgent: httpsAgent,
            timeout: 30000
        });

        const dados = response.data;
        console.log('   ✓ Dados recebidos da SEFIN');

        // 🔧 DESCOMPRIME O XML
        let xmlNFSe = null;
        if (dados.nfseXmlGZipB64) {
            console.log('   → Descomprimindo XML da NFS-e...');
            xmlNFSe = this.decodificarEDescomprimir(dados.nfseXmlGZipB64);
            console.log('   ✓ XML descomprimido!');
        }

        const resultado = {
            sucesso: true,
            numeroNFSe: dados.numero || dados.numeroNFSe || null,
            codigoVerificacao: dados.codigoVerificacao || dados.codVerificacao || null,
            dataEmissao: dados.dataEmissao || dados.dhEmi || dados.dataHoraProcessamento || null,
            situacao: dados.situacao || 'Autorizada',
            xmlNFSe: xmlNFSe,  // ✨ XML descomprimido
            nfseXmlGZipB64: dados.nfseXmlGZipB64,
            dadosCompletos: dados
        };

        return resultado;

    } catch (error) {
        console.error('   ✗ Erro ao consultar NFS-e:', error.message);
        
        if (error.response?.status === 404) {
            return { sucesso: false, erro: 'NFS-e ainda não disponível para consulta' };
        }
        return { sucesso: false, erro: error.message };
    }
}

    static async consultarChaveAcesso(idDPS, cnpjEmpresa, tipoAmbiente) {
        try {
            const certInfo = await CertificadoService.buscarCertificadoPorCNPJ(cnpjEmpresa);
            const { privateKeyPem, certificatePem } = CertificadoService.extrairCertificadoPEM(certInfo.certificadoBuffer, certInfo.senha);

            const httpsAgent = new https.Agent({
                cert: certificatePem,
                key: privateKeyPem,
                rejectUnauthorized: tipoAmbiente === '1'
            });

            const urlSefin = tipoAmbiente === '1' ? 'https://sefin.producao.nfse.gov.br/SefinNacional' : 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional';
            const urlCompleta = `${urlSefin}/dps/${idDPS}`;

            const response = await axios.get(urlCompleta, {
                headers: { 'Accept': 'application/json' },
                httpsAgent: httpsAgent,
                timeout: 30000
            });

            const chaveAcesso = response.data?.chaveAcesso || response.data?.ChaveAcesso;

            if (!chaveAcesso) {
                return { sucesso: false, erro: 'Chave não disponível' };
            }

            return { sucesso: true, chaveAcesso: chaveAcesso };

        } catch (error) {
            if (error.response?.status === 404) {
                return { sucesso: false, erro: 'DPS ainda não processada' };
            }
            return { sucesso: false, erro: error.message };
        }
    }

/**
 * Monta link de consulta
 */
static montarLinkConsulta(chaveAcesso, tipoAmbiente) {
    const urlBase = tipoAmbiente === '1'
        ? 'https://sefin.producao.nfse.gov.br'
        : 'https://sefin.producaorestrita.nfse.gov.br';

    return `${urlBase}/SefinNacional/nfse/${chaveAcesso}`;
}

/**
 * Monta link do PDF (DANFSE)
 */
static montarLinkPDF(chaveAcesso, tipoAmbiente) {
    const urlBase = tipoAmbiente === '1'
        ? 'https://adn.producao.nfse.gov.br'
        : 'https://adn.producaorestrita.nfse.gov.br';

    return `${urlBase}/danfse/${chaveAcesso}`;
}

/**
     * Baixa o PDF (DANFSE) da SEFIN e retorna em Base64
     * Utiliza o certificado digital para autenticação
     */
    static async baixarPDFBase64(chaveAcesso, cnpjEmpresa, tipoAmbiente) {
        try {
            console.log(`   → Baixando PDF para chave: ${chaveAcesso}`);

            // 1. Prepara o certificado
            const certInfo = await CertificadoService.buscarCertificadoPorCNPJ(cnpjEmpresa);
            
            const { privateKeyPem, certificatePem } = 
                CertificadoService.extrairCertificadoPEM(
                    certInfo.certificadoBuffer,
                    certInfo.senha
                );

            const httpsAgent = new https.Agent({
                cert: certificatePem,
                key: privateKeyPem,
                rejectUnauthorized: tipoAmbiente === '1' // Valida SSL apenas em produção
            });

            // 2. Define a URL correta do PDF
            const urlBase = tipoAmbiente === '1'
                ? 'https://adn.producao.nfse.gov.br'
                : 'https://adn.producaorestrita.nfse.gov.br';
            
            const urlPDF = `${urlBase}/danfse/${chaveAcesso}`;

            // 3. Faz a requisição para pegar o binário do PDF
            const response = await axios.get(urlPDF, {
                httpsAgent: httpsAgent,
                responseType: 'arraybuffer', // Essencial para arquivos binários
                timeout: 30000
            });

            // 4. Converte Buffer para Base64
            const pdfBase64 = Buffer.from(response.data, 'binary').toString('base64');
            
            // Calcula tamanho aproximado em KB para log/retorno
            const tamanhoKB = (pdfBase64.length * 0.75 / 1024).toFixed(2); 

            console.log(`   ✓ PDF baixado com sucesso (${tamanhoKB} KB)`);

            return {
                sucesso: true,
                pdfBase64: pdfBase64,
                tamanhoKB: `${tamanhoKB} KB`
            };

        } catch (error) {
            console.error('   ❌ Erro ao baixar PDF:', error.message);
            
            let msgErro = error.message;
            if (error.response && error.response.status === 404) {
                msgErro = 'PDF ainda não disponível na SEFIN';
            }

            return {
                sucesso: false,
                erro: msgErro
            };
        }
    }

    static async atualizarTransmissaoComDadosNFSe(transmissaoId, dadosNFSe) {
        try {
            const sql = `
                UPDATE nfse_transmissoes 
                SET 
                    chave_acesso_nfse = ?,
                    numero_nfse = ?,
                    codigo_verificacao = ?,
                    link_consulta = ?,
                    data_emissao_nfse = ?,
                    situacao_nfse = ?,
                    xml_nfse = ?,
                    dps_limpa = ?,
                    status_processamento = ?,
                    resposta_completa = ?
                WHERE id = ?
            `;

            const params = [
                dadosNFSe.chaveAcesso,
                dadosNFSe.numeroNFSe,
                dadosNFSe.codigoVerificacao,
                dadosNFSe.linkConsulta,
                dadosNFSe.dataEmissao,
                dadosNFSe.situacao,
                dadosNFSe.xmlNFSe,
                dadosNFSe.dpsLimpa,
                dadosNFSe.statusProcessamento,
                JSON.stringify(dadosNFSe),
                transmissaoId
            ];

            await query(sql, params);
            console.log(`   ✓ Transmissão ${transmissaoId} atualizada`);

        } catch (error) {
            console.error('Erro ao atualizar transmissão:', error.message);
        }
    }
}

module.exports = SefinResponseProcessor;