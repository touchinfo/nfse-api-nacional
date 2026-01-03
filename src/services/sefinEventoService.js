const axios = require('axios');
const https = require('https');
const CertificadoService = require('./certificadoService');
const XMLEventoService = require('./xmlEventoService');
const SefinConfig = require('./sefinConfig');

class SefinEventoService {

    static async enviarEvento(eventoXmlGZipB64, chaveAcesso, cnpjEmpresa) {
        try {
            const ambiente = SefinConfig.getNomeAmbiente();
            
            console.log('📤 Enviando evento para SEFIN Nacional...');
            console.log(`   Ambiente: ${ambiente}`);

            const certInfo = await CertificadoService.buscarCertificadoPorCNPJ(cnpjEmpresa);

            const { privateKeyPem, certificatePem } =
                CertificadoService.extrairCertificadoPEM(
                    certInfo.certificadoBuffer,
                    certInfo.senha
                );

            const httpsAgent = new https.Agent({
                cert: certificatePem,
                key: privateKeyPem,
                rejectUnauthorized: SefinConfig.validarSSL()
            });

            console.log('  → Certificado configurado para mTLS');

            const urlSefin = `${SefinConfig.getURLSefin()}/SefinNacional/nfse/${chaveAcesso}/eventos`;
            
            console.log(`  → POST ${urlSefin}`);

            const inicioEnvio = Date.now();

            const response = await axios.post(
                urlSefin,
                { pedidoRegistroEventoXmlGZipB64: eventoXmlGZipB64 },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    },
                    httpsAgent: httpsAgent,
                    timeout: 30000
                }
            );

            const tempoProcessamento = Date.now() - inicioEnvio;
            console.log(`✅ Resposta da SEFIN (${tempoProcessamento}ms)`);

            return {
                sucesso: true,
                status: response.status,
                dados: response.data,
                tempoProcessamento
            };

        } catch (error) {
            console.error('❌ Erro ao enviar evento:', error.message);

            if (error.response) {
                return {
                    sucesso: false,
                    status: error.response.status,
                    dados: error.response.data,
                    erro: `Erro HTTP ${error.response.status}`,
                    detalhes: error.response.data
                };
            }

            return {
                sucesso: false,
                erro: error.message,
                tipo: error.code || 'ERRO_DESCONHECIDO'
            };
        }
    }

    /**
     * Envia evento de CANCELAMENTO
     */
    static async enviarEventoCancelamento(dados, cnpjEmpresa) {
        try {
            const ambiente = SefinConfig.getNomeAmbiente();
            
            console.log('📤 Enviando evento de CANCELAMENTO...');
            console.log(`   Ambiente: ${ambiente}`);
            console.log(`   NFS-e: ${dados.chaveAcesso}`);

            // Processa o XML do evento (monta, assina, comprime)
            const eventoProcessado = await XMLEventoService.processarCancelamento(
                {
                    ...dados,
                    tipoAmbiente: SefinConfig.obterAmbiente() // Passa '1' ou '2'
                },
                cnpjEmpresa
            );

            // Envia usando método genérico
            const resultado = await this.enviarEvento(
                eventoProcessado.eventoXmlGZipB64,
                dados.chaveAcesso,
                cnpjEmpresa
            );

            if (resultado.sucesso) {
                return {
                    sucesso: true,
                    tipoEvento: '101101',
                    chaveAcesso: dados.chaveAcesso,
                    respostaSefin: resultado.dados,
                    xmlEnviado: eventoProcessado.xmlAssinado,
                    tempoProcessamento: resultado.tempoProcessamento
                };
            } else {
                return {
                    sucesso: false,
                    erro: resultado.erro,
                    respostaSefin: resultado.dados || resultado.detalhes
                };
            }

        } catch (error) {
            console.error('❌ Erro ao enviar cancelamento:', error.message);
            return {
                sucesso: false,
                erro: error.message
            };
        }
    }

    /**
     * Envia evento de SUBSTITUIÇÃO
     */
    static async enviarEventoSubstituicao(dados, cnpjEmpresa) {
        try {
            const ambiente = SefinConfig.getNomeAmbiente();
            
            console.log('📤 Enviando evento de SUBSTITUIÇÃO...');
            console.log(`   Ambiente: ${ambiente}`);
            console.log(`   NFS-e Original: ${dados.chaveAcesso}`);
            console.log(`   NFS-e Substituta: ${dados.chaveSubstituta}`);

            // Processa o XML do evento (monta, assina, comprime)
            const eventoProcessado = await XMLEventoService.processarSubstituicao(
                {
                    ...dados,
                    tipoAmbiente: SefinConfig.obterAmbiente() // Passa '1' ou '2'
                },
                cnpjEmpresa
            );

            // Envia usando método genérico
            const resultado = await this.enviarEvento(
                eventoProcessado.eventoXmlGZipB64,
                dados.chaveAcesso,
                cnpjEmpresa
            );

            if (resultado.sucesso) {
                return {
                    sucesso: true,
                    tipoEvento: '105102',
                    chaveAcesso: dados.chaveAcesso,
                    chaveSubstituta: dados.chaveSubstituta,
                    respostaSefin: resultado.dados,
                    xmlEnviado: eventoProcessado.xmlAssinado,
                    tempoProcessamento: resultado.tempoProcessamento
                };
            } else {
                return {
                    sucesso: false,
                    erro: resultado.erro,
                    respostaSefin: resultado.dados || resultado.detalhes
                };
            }

        } catch (error) {
            console.error('❌ Erro ao enviar substituição:', error.message);
            return {
                sucesso: false,
                erro: error.message
            };
        }
    }
}

module.exports = SefinEventoService;