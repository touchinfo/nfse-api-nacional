const axios = require('axios');
const https = require('https');
const zlib = require('zlib');
const { query } = require('../config/database');
const CertificadoService = require('./certificadoService');

/**
 * Service para processar resposta completa da SEFIN
 * COM CORREÇÃO DE LINK DE CONSULTA E BLINDAGEM CONTRA ERROS
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
                mensagem: null,
                erros: [],
                statusProcessamento: null
            };

            // Verifica erro HTTP/Conexão
            if (!respostaSefin.sucesso) {
                resultado.mensagem = 'Erro ao enviar DPS para a SEFIN';
                resultado.erros = respostaSefin.dados?.erros || [respostaSefin.erro];
                resultado.statusProcessamento = 'ERRO_ENVIO';
                return resultado;
            }

            // Extrai dados básicos
            const dadosSefin = respostaSefin.dados;
            resultado.protocolo = dadosSefin.protocolo || dadosSefin.numeroProtocolo;
            resultado.chaveAcesso = dadosSefin.chaveAcesso;

            console.log(`   → Protocolo: ${resultado.protocolo}`);
            console.log(`   → Chave de Acesso: ${resultado.chaveAcesso || 'Não disponível ainda'}`);

            // ==============================================================================
            // BLINDAGEM 1: Converte para String (100 vs '100')
            // ==============================================================================
            const codigoRetorno = dadosSefin.codigo ? String(dadosSefin.codigo) : String(dadosSefin.codigoRetorno || '');
            
            if (codigoRetorno === '100') {
                // AUTORIZADA
                console.log('   ✅ DPS AUTORIZADA!');
                resultado.statusProcessamento = 'AUTORIZADA';
                resultado.sucesso = true;
                
            } else if (codigoRetorno === '105') {
                // PENDENTE
                console.log('   ⏳ DPS PENDENTE DE PROCESSAMENTO');
                resultado.statusProcessamento = 'PENDENTE';
                resultado.sucesso = true; 
                resultado.mensagem = 'DPS recebida e está sendo processada pela SEFIN';
                
                // Aguarda antes da primeira tentativa
                console.log('   → Aguardando 5 segundos para consultar novamente...');
                await this.aguardar(5000);
                
            } else {
                // ==============================================================================
                // BLINDAGEM 2: Se tem chave, é sucesso (mesmo com código estranho)
                // ==============================================================================
                if (resultado.chaveAcesso) {
                    console.warn(`   ⚠️ Código de retorno atípico (${codigoRetorno}), mas Chave de Acesso existe. Forçando sucesso.`);
                    resultado.statusProcessamento = 'AUTORIZADA';
                    resultado.sucesso = true;
                    resultado.mensagem = dadosSefin.mensagem || 'DPS processada com sucesso (código atípico)';
                } else {
                    // ERRO REAL
                    console.log(`   ❌ DPS REJEITADA - Código: ${codigoRetorno}`);
                    resultado.mensagem = dadosSefin.mensagem || 'DPS rejeitada pela SEFIN';
                    resultado.erros = dadosSefin.erros || [];
                    resultado.statusProcessamento = 'REJEITADA';
                    resultado.sucesso = false;
                    return resultado;
                }
            }

            // Tenta obter chave de acesso (com retry se necessário)
            let tentativas = 0;
            const maxTentativas = 3;
            
            while (!resultado.chaveAcesso && tentativas < maxTentativas) {
                tentativas++;
                
                if (tentativas > 1) {
                    console.log(`   → Tentativa ${tentativas}/${maxTentativas} de obter chave de acesso...`);
                    await this.aguardar(3000 * tentativas); 
                }

                const chaveResult = await this.consultarChaveAcesso(
                    infoDPS.idDPS,
                    cnpjEmpresa,
                    tipoAmbiente
                );

                if (chaveResult.sucesso) {
                    resultado.chaveAcesso = chaveResult.chaveAcesso;
                    console.log(`   ✓ Chave obtida: ${resultado.chaveAcesso}`);
                    break;
                }
            }

            // Se não tem chave e não está pendente -> ERRO
            if (!resultado.chaveAcesso) {
                if (resultado.statusProcessamento === 'PENDENTE') {
                    console.log('   ⚠️  Chave ainda não disponível, mas DPS foi aceita');
                    resultado.sucesso = true;
                    resultado.mensagem = 'DPS aceita. Consulte novamente em breve.';
                    return resultado;
                }
                
                console.log('   ❌ Não foi possível obter chave de acesso');
                resultado.mensagem = 'DPS enviada mas chave de acesso não disponível';
                resultado.statusProcessamento = 'SEM_CHAVE';
                resultado.sucesso = false;
                return resultado;
            }

            // Consulta dados completos da NFS-e
            console.log('   → Consultando NFS-e completa...');
            
            const dadosNFSeResult = await this.consultarDadosNFSe(
                resultado.chaveAcesso,
                cnpjEmpresa,
                tipoAmbiente
            );

            if (dadosNFSeResult.sucesso) {
                resultado.numeroNFSe = dadosNFSeResult.numeroNFSe;
                resultado.codigoVerificacao = dadosNFSeResult.codigoVerificacao;
                resultado.dataEmissao = dadosNFSeResult.dataEmissao;
                resultado.situacao = dadosNFSeResult.situacao;
                resultado.dadosCompletos = dadosNFSeResult.dadosCompletos;
                
                // DESCOMPRIME O XML DA NFS-E
                if (dadosNFSeResult.nfseXmlGZipB64) {
                    console.log('   → Descomprimindo XML...');
                    try {
                        resultado.xmlNFSe = this.decodificarEDescomprimir(
                            dadosNFSeResult.nfseXmlGZipB64
                        );
                        console.log('   ✓ XML descomprimido!');
                    } catch (error) {
                        console.warn(`   ⚠️  Erro ao descomprimir: ${error.message}`);
                    }
                }
                
                console.log(`   ✓ Número NFS-e: ${resultado.numeroNFSe || 'Ainda não disponível'}`);
                
                // Atualiza status final
                if (resultado.situacao === 'Pendente' || resultado.situacao === 'Em processamento') {
                    resultado.statusProcessamento = 'PROCESSANDO';
                    resultado.mensagem = 'NFS-e aceita e em processamento.';
                } else {
                    resultado.sucesso = true;
                    resultado.statusProcessamento = 'CONCLUIDA';
                    resultado.mensagem = 'NFS-e emitida com sucesso';
                }
            } else {
                console.log('   ⚠️  Não foi possível consultar dados completos ainda');
                resultado.sucesso = true;
                resultado.statusProcessamento = 'AGUARDANDO_DADOS';
                resultado.mensagem = 'DPS aceita. Dados completos em breve.';
            }

            // Monta link de consulta (AGORA COM A ROTA CORRETA)
            resultado.linkConsulta = this.montarLinkConsulta(
                resultado.chaveAcesso,
                tipoAmbiente
            );

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

            // URL correta para obter o JSON da nota
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

            const resultado = {
                sucesso: true,
                numeroNFSe: dados.numero || dados.numeroNFSe || null,
                codigoVerificacao: dados.codigoVerificacao || dados.codVerificacao || null,
                dataEmissao: dados.dataEmissao || dados.dhEmi || dados.dataHoraProcessamento || null,
                situacao: dados.situacao || 'Autorizada',
                nfseXmlGZipB64: dados.nfseXmlGZipB64 || null,
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

    /**
     * Consulta a chave de acesso usando o ID da DPS
     */
    static async consultarChaveAcesso(idDPS, cnpjEmpresa, tipoAmbiente) {
        try {
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
                ? 'https://sefin.producao.nfse.gov.br/SefinNacional'
                : 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional';

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
     * CORRIGIDO: Usa a rota /nfse/ que retorna os dados corretos
     */
    static montarLinkConsulta(chaveAcesso, tipoAmbiente) {
        const urlBase = tipoAmbiente === '1'
            ? 'https://sefin.producao.nfse.gov.br'
            : 'https://sefin.producaorestrita.nfse.gov.br';

        // Usa a rota /nfse/ que é a correta para consulta de dados
        return `${urlBase}/SefinNacional/nfse/${chaveAcesso}`;
    }

    /**
     * Atualiza transmissão no banco com dados da NFS-e
     */
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
                    status_processamento = ?,
                    resposta_completa = ?,
                    updated_at = CURRENT_TIMESTAMP
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