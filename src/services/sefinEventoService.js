// SUBSTITUA TODO O ARQUIVO POR ESTE:

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
     * ✅ HELPER: Obtém o tipo de ambiente do .env ou fallback
     */
    static obterTipoAmbiente(tipoAmbienteFallback) {
        return process.env.SEFIN_AMBIENTE || tipoAmbienteFallback || '2';
    }

    /**
     * URL base da SEFIN
     * ✅ CORRIGIDO: 1 = Produção, 2 = Homologação
     */
    static getURLBase(tipoAmbiente) {
        // Garante que lê do ENV primeiro
        const ambiente = this.obterTipoAmbiente(tipoAmbiente);
        
        return ambiente === '1'
            ? 'https://sefin.nfse.gov.br'
            : 'https://sefin.producaorestrita.nfse.gov.br';
    }

    /**
     * Envia evento genérico para a SEFIN Nacional
     * POST /SefinNacional/nfse/{chaveAcesso}/eventos
     */
    static async enviarEvento(eventoXmlGZipB64, chaveAcesso, cnpjEmpresa, tipoAmbienteParam) {
        try {
            // ✅ SEMPRE lê do ENV primeiro!
            const tipoAmbiente = this.obterTipoAmbiente(tipoAmbienteParam);
            
            console.log('📤 Enviando evento para SEFIN Nacional...');
            console.log(`   Ambiente: ${tipoAmbiente === '1' ? 'PRODUÇÃO' : 'HOMOLOGAÇÃO'}`);

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
     */
    static async enviarEventoSubstituicao(dados, cnpjEmpresa) {
        try {
            // ✅ SEMPRE lê do ENV primeiro!
            const tipoAmbiente = this.obterTipoAmbiente(dados.tipoAmbiente);
            
            console.log('📤 Enviando evento de SUBSTITUIÇÃO para SEFIN...');
            console.log(`   Ambiente: ${tipoAmbiente === '1' ? 'PRODUÇÃO' : 'HOMOLOGAÇÃO'}`);
            console.log(`   NFS-e Original: ${dados.chaveAcesso}`);
            console.log(`   NFS-e Substituta: ${dados.chaveSubstituta}`);

            // 1. Processa o XML do evento (monta, assina, comprime)
            const eventoProcessado = await XMLEventoService.processarSubstituicao({
                ...dados,
                tipoAmbiente // Passa o ambiente já resolvido
            }, cnpjEmpresa);

            // 2. Envia usando método genérico
            const resultado = await this.enviarEvento(
                eventoProcessado.eventoXmlGZipB64,
                dados.chaveAcesso,
                cnpjEmpresa,
                tipoAmbiente
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