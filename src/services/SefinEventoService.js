const axios = require('axios');
const https = require('https');
const CertificadoService = require('./certificadoService');
const XMLEventoService = require('./xmlEventoService');

/**
 * Service para envio de eventos à SEFIN Nacional
 * Eventos suportados:
 * - 101101: Cancelamento de NFS-e
 * - 105102: Substituição de NFS-e
 */
class SefinEventoService {

    /**
     * URL base da SEFIN
     */
    static getURLBase(tipoAmbiente) {
        return tipoAmbiente === '1'
            ? 'https://sefin.producao.nfse.gov.br'
            : 'https://sefin.producaorestrita.nfse.gov.br';
    }

    /**
     * Envia evento genérico para a SEFIN Nacional
     * POST /SefinNacional/nfse/{chaveAcesso}/eventos
     */
    static async enviarEvento(eventoXmlGZipB64, chaveAcesso, cnpjEmpresa, tipoAmbiente = '2') {
        try {
            console.log('📤 Enviando evento para SEFIN Nacional...');

            // Busca certificado para mTLS
            console.log('  → Configurando certificado para autenticação mTLS...');
            const certInfo = await CertificadoService.buscarCertificadoPorCNPJ(cnpjEmpresa);

            const { privateKeyPem, certificatePem } =
                CertificadoService.extrairCertificadoPEM(
                    certInfo.certificadoBuffer,
                    certInfo.senha
                );

            // HTTPS Agent com mTLS
            const httpsAgent = new https.Agent({
                cert: certificatePem,
                key: privateKeyPem,
                rejectUnauthorized: tipoAmbiente === '1'
            });

            console.log('  → Certificado configurado para mTLS');

            // URL correta: /SefinNacional/nfse/{chaveAcesso}/eventos
            const urlBase = this.getURLBase(tipoAmbiente);
            const urlSefin = `${urlBase}/SefinNacional/nfse/${chaveAcesso}/eventos`;
            
            console.log(`  → Enviando para: ${urlSefin}`);

            const inicioEnvio = Date.now();

            // Envia requisição - body: pedidoRegistroEventoXmlGZipB64
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
            console.log(`✅ Resposta recebida da SEFIN (${tempoProcessamento}ms)`);

            return {
                sucesso: true,
                status: response.status,
                dados: response.data,
                tempoProcessamento
            };

        } catch (error) {
            console.error('❌ Erro ao enviar evento para SEFIN:', error.message);

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
     * Envia evento de SUBSTITUIÇÃO para a SEFIN
     * 
     * FLUXO DE SUBSTITUIÇÃO:
     * 1. Primeiro emita a nova NFS-e (substituta) via POST /api/nfse/emitir
     * 2. Depois chame este método passando a chave original e a chave da nova
     * 3. A nota original ficará com situação "Substituída"
     * 
     * @param {Object} dados
     * @param {string} dados.chaveAcesso - Chave da NFS-e ORIGINAL (será substituída)
     * @param {string} dados.chaveSubstituta - Chave da NFS-e NOVA (substituta)
     * @param {number} dados.codigoMotivo - Código do motivo (1-9)
     * @param {string} dados.motivoTexto - Descrição do motivo (15-255 chars)
     * @param {string} dados.tipoAmbiente - 1=Produção, 2=Homologação
     * @param {string} dados.versaoAplicacao - Versão do aplicativo
     * @param {string} cnpjEmpresa - CNPJ da empresa
     */
    static async enviarEventoSubstituicao(dados, cnpjEmpresa) {
        try {
            console.log('📤 Enviando evento de SUBSTITUIÇÃO para SEFIN...');
            console.log(`   NFS-e Original: ${dados.chaveAcesso}`);
            console.log(`   NFS-e Substituta: ${dados.chaveSubstituta}`);

            // 1. Processa o XML do evento (monta, assina, comprime)
            const eventoProcessado = await XMLEventoService.processarSubstituicao(dados, cnpjEmpresa);

            // 2. Envia usando método genérico
            const resultado = await this.enviarEvento(
                eventoProcessado.eventoXmlGZipB64,
                dados.chaveAcesso,
                cnpjEmpresa,
                dados.tipoAmbiente
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
            console.error('❌ Erro ao enviar evento de substituição:', error.message);
            return {
                sucesso: false,
                erro: error.message
            };
        }
    }
}

module.exports = SefinEventoService;