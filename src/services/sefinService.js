const axios = require('axios');
const https = require('https');
const { query } = require('../config/database');
const CertificadoService = require('./certificadoService');
const XMLEventoService = require('./xmlEventoService');
const SefinConfig = require('./sefinConfig');

/**
 * Service para comunicação com a SEFIN Nacional
 */
class SefinService {
   /**
     * Consulta os parâmetros de convênio de um município
     */
    static async consultarParametrosConvenio(codigoMunicipio, cnpjEmpresa) {
        try {
            const ambiente = SefinConfig.getNomeAmbiente();
            console.log(`🔍 Consultando parâmetros de convênio do município ${codigoMunicipio}...`);
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
            
            const urlCompleta = `${SefinConfig.getURLADN()}/parametrizacao/${codigoMunicipio}/convenio`;
            
            console.log(`  → GET ${urlCompleta}`);
            
            const inicioConsulta = Date.now();
            
            const response = await axios.get(urlCompleta, {
                headers: { 'Accept': 'application/json' },
                httpsAgent: httpsAgent,
                timeout: parseInt(process.env.SEFIN_TIMEOUT) || 30000
            });
            
            const tempoProcessamento = Date.now() - inicioConsulta;
            
            console.log(`✅ Parâmetros obtidos (${tempoProcessamento}ms)`);
            
            return {
                sucesso: true,
                status: response.status,
                dados: response.data,
                tempoProcessamento
            };
            
        } catch (error) {
            console.error('❌ Erro ao consultar parâmetros:', error.message);
            
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
     * Envia a DPS para a SEFIN Nacional
     */
    static async enviarDPS(dpsXmlGZipB64, cnpjEmpresa) {
        try {
            const ambiente = SefinConfig.getNomeAmbiente();
            console.log('📤 Enviando DPS para SEFIN Nacional...');
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
            
            const urlSefin = SefinConfig.getURLSefin();
            
            console.log(`  → POST ${urlSefin}`);
            
            const inicioEnvio = Date.now();
            
            const response = await axios.post(
                urlSefin,
                { dpsXmlGZipB64 },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    },
                    httpsAgent: httpsAgent,
                    timeout: parseInt(process.env.SEFIN_TIMEOUT) || 30000
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
            console.error('❌ Erro ao enviar para SEFIN:', error.message);
            
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
     * Registra transmissão no banco de dados
     */
    static async registrarTransmissao(dados) {
        const sql = `
            INSERT INTO nfse_transmissoes (
                empresa_id,
                id_dps,
                numero_dps,
                serie_dps,
                xml_enviado,
                xml_assinado,
                dps_base64,
                status_envio,
                codigo_retorno,
                mensagem_retorno,
                resposta_completa,
                numero_protocolo,
                data_recebimento,
                ip_origem,
                user_agent,
                tempo_processamento_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        
        const params = [
            dados.empresaId,
            dados.idDPS,
            dados.numeroDPS,
            dados.serieDPS,
            dados.xmlOriginal,
            dados.xmlAssinado,
            dados.dpsBase64,
            dados.statusEnvio,
            dados.codigoRetorno || null,
            dados.mensagemRetorno || null,
            dados.respostaCompleta ? JSON.stringify(dados.respostaCompleta) : null,
            dados.numeroProtocolo || null,
            dados.dataRecebimento || null,
            dados.ipOrigem || null,
            dados.userAgent || null,
            dados.tempoProcessamento || null
        ];
        
        const result = await query(sql, params);
        return result.insertId;
    }

    /**
     * Atualiza o último número de DPS usado
     */
    static async atualizarUltimoNumeroDPS(empresaId, numeroDPS) {
        const sql = `
            UPDATE empresas 
            SET ultimo_numero_dps = ?
            WHERE id = ? AND ultimo_numero_dps < ?
        `;
        
        await query(sql, [numeroDPS, empresaId, numeroDPS]);
    }

        /**
     * Consulta NFS-e completa pela chave
     */
    static async consultarNFSeCompleta(chaveAcesso, cnpjEmpresa, tipoAmbiente) {
        try {
            // Busca certificado
            const certInfo = await CertificadoService.buscarCertificadoPorCNPJ(cnpjEmpresa);
            
            const { privateKeyPem, certificatePem } = 
                CertificadoService.extrairCertificadoPEM(
                    certInfo.certificadoBuffer,
                    certInfo.senha
                );

            // HTTPS Agent com mTLS
            const https = require('https');
            const httpsAgent = new https.Agent({
                cert: certificatePem,
                key: privateKeyPem,
                rejectUnauthorized: tipoAmbiente === '1'
            });

            // URL CORRETA
            const urlBase = tipoAmbiente === '1'
                ? 'https://sefin.nfse.gov.br'
                : 'https://sefin.producaorestrita.nfse.gov.br';

            const urlCompleta = `${urlBase}/SefinNacional/nfse/${chaveAcesso}`;

            console.log(`Consultando: ${urlCompleta}`);

            // Faz requisição
            const axios = require('axios');
            const response = await axios.get(urlCompleta, {
                headers: { 'Accept': 'application/json' },
                httpsAgent: httpsAgent,
                timeout: 30000
            });

            const dados = response.data;

            // Descomprime o XML se existir
            let xmlNFSe = null;
            if (dados.nfseXmlGZipB64) {
                console.log('Descomprimindo XML...');
                xmlNFSe = this.decodificarEDescomprimir(dados.nfseXmlGZipB64);
                console.log('XML descomprimido com sucesso!');
            }

            return {
                sucesso: true,
                numeroNFSe: dados.numero || dados.numeroNFSe,
                codigoVerificacao: dados.codigoVerificacao,
                dataEmissao: dados.dataEmissao,
                situacao: dados.situacao || 'Autorizada',
                xmlNFSe: xmlNFSe  // ✨ XML descomprimido
            };

        } catch (error) {
            console.error('Erro ao consultar NFS-e:', error.message);
            return {
                sucesso: false,
                erro: error.message
            };
        }
    }

    /**
     * Consulta status de uma transmissão
     */
    static async consultarTransmissao(idDPS, cnpjEmpresa) {
        const sql = `
            SELECT 
                t.*,
                e.razao_social,
                e.cnpj
            FROM nfse_transmissoes t
            INNER JOIN empresas e ON t.empresa_id = e.id
            WHERE t.id_dps = ? AND e.cnpj = ?
        `;
        
        const results = await query(sql, [idDPS, cnpjEmpresa]);
        
        if (results.length === 0) {
            return null;
        }
        
        const transmissao = results[0];
        
        // Parse do JSON de resposta
        if (transmissao.resposta_completa) {
            try {
                transmissao.resposta_completa = JSON.parse(transmissao.resposta_completa);
            } catch (e) {
                // Mantém como string se não conseguir fazer parse
            }
        }
        
        return transmissao;
    }

  /**
     * Consulta TODOS os eventos registrados de uma NFS-e
     */
    static async consultarEventosNFSe(chaveAcesso, cnpjEmpresa, descomprimirXML = false) {
        try {
            console.log(`🔍 Consultando eventos da NFS-e: ${chaveAcesso.substring(0, 20)}...`);
            
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
            
            const urlCompleta = `${SefinConfig.getURLSefin()}/SefinNacional/nfse/${chaveAcesso}/eventos`;
            
            console.log(`  → GET ${urlCompleta}`);
            
            const response = await axios.get(urlCompleta, {
                headers: { 'Accept': 'application/json' },
                httpsAgent: httpsAgent,
                timeout: 30000
            });
            
            let eventos = Array.isArray(response.data) ? response.data : [];
            
            // Descomprime XMLs se solicitado
            if (descomprimirXML && eventos.length > 0) {
                const SefinResponseProcessor = require('./sefinResponseProcessor');
                eventos = eventos.map(evento => {
                    if (evento.eventoXmlGZipB64) {
                        try {
                            evento.eventoXML = SefinResponseProcessor.decodificarEDescomprimir(evento.eventoXmlGZipB64);
                        } catch (e) {
                            console.error('Erro ao descomprimir XML do evento:', e.message);
                        }
                    }
                    return evento;
                });
            }
            
            console.log(`✅ ${eventos.length} evento(s) encontrado(s)`);
            
            return {
                sucesso: true,
                quantidade: eventos.length,
                eventos: eventos
            };
            
        } catch (error) {
            if (error.response?.status === 404) {
                return { sucesso: true, quantidade: 0, eventos: [], status: 404 };
            }
            
            console.error('❌ Erro ao consultar eventos:', error.message);
            return {
                sucesso: false,
                erro: error.message,
                status: error.response?.status || 500
            };
        }
    }

  /**
     * Consulta um evento ESPECÍFICO
     */
    static async consultarEventoEspecifico(chaveAcesso, tipoEvento, numSeqEvento, cnpjEmpresa, descomprimirXML = false) {
        try {
            console.log(`🔍 Consultando evento tipo ${tipoEvento} seq ${numSeqEvento}`);
            
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
            
            const urlCompleta = `${SefinConfig.getURLSefin()}/SefinNacional/nfse/${chaveAcesso}/eventos/${tipoEvento}/${numSeqEvento}`;
            
            console.log(`  → GET ${urlCompleta}`);
            
            const response = await axios.get(urlCompleta, {
                headers: { 'Accept': 'application/json' },
                httpsAgent: httpsAgent,
                timeout: 30000
            });
            
            let evento = response.data;
            
            if (descomprimirXML && evento.eventoXmlGZipB64) {
                const SefinResponseProcessor = require('./sefinResponseProcessor');
                try {
                    evento.eventoXML = SefinResponseProcessor.decodificarEDescomprimir(evento.eventoXmlGZipB64);
                } catch (e) {
                    console.error('Erro ao descomprimir XML:', e.message);
                }
            }
            
            console.log(`✅ Evento encontrado`);
            
            return {
                sucesso: true,
                evento: evento
            };
            
        } catch (error) {
            if (error.response?.status === 404) {
                return {
                    sucesso: false,
                    status: 404,
                    erro: 'Evento não encontrado'
                };
            }
            
            console.error('❌ Erro ao consultar evento:', error.message);
            return {
                sucesso: false,
                erro: error.message,
                status: error.response?.status || 500
            };
        }
    }
    /**
     * Registra um evento na NFS-e (cancelamento, carta de correção, etc)
     * POST /nfse/{chaveAcesso}/eventos
     * 
     * Body: {"pedidoRegistroEventoXmlGZipB64": "string"}
     * 
     * @param {string} chaveAcesso - Chave de acesso da NFS-e (50 caracteres)
     * @param {Object} dadosEvento - Dados do evento a registrar
     * @param {string} cnpjEmpresa - CNPJ do emitente
     * @param {string} tipoAmbiente - 1=Produção, 2=Homologação
     */
    static async registrarEvento(chaveAcesso, dadosEvento, cnpjEmpresa, tipoAmbiente) {
        try {
            console.log(`📤 Registrando evento tipo ${dadosEvento.tpEvento} para NFS-e: ${chaveAcesso.substring(0, 20)}...`);
            
            // 1. Processa o evento: monta XML, assina e comprime
            const eventoProcessado = await XMLEventoService.processarEvento(
                dadosEvento,
                cnpjEmpresa
            );
            
            // 2. Busca certificado para mTLS
            const certInfo = await CertificadoService.buscarCertificadoPorCNPJ(cnpjEmpresa);
            
            const { privateKeyPem, certificatePem } = 
                CertificadoService.extrairCertificadoPEM(
                    certInfo.certificadoBuffer,
                    certInfo.senha
                );
            
            // 3. HTTPS Agent com mTLS
            const httpsAgent = new https.Agent({
                cert: certificatePem,
                key: privateKeyPem,
                rejectUnauthorized: tipoAmbiente === '1'
            });
            
            // 4. URL correta
            const urlBase = tipoAmbiente === '1'
                ? 'https://sefin.nfse.gov.br'
                : 'https://sefin.producaorestrita.nfse.gov.br';
            
            const urlCompleta = `${urlBase}/SefinNacional/nfse/${chaveAcesso}/eventos`;
            
            console.log(`  → POST ${urlCompleta}`);
            
            const inicioEnvio = Date.now();
            
            // 5. Envia POST com XML comprimido e assinado
            const response = await axios.post(
                urlCompleta,
                {
                    pedidoRegistroEventoXmlGZipB64: eventoProcessado.pedidoRegistroEventoXmlGZipB64
                },
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
            
            console.log(`✅ Evento registrado com sucesso (${tempoProcessamento}ms)`);
            
            return {
                sucesso: true,
                status: response.status,
                dados: response.data,
                xmlOriginal: eventoProcessado.xmlOriginal,
                xmlAssinado: eventoProcessado.xmlAssinado,
                tempoProcessamento
            };
            
        } catch (error) {
            console.error('❌ Erro ao registrar evento:', error.message);
            
            if (error.response) {
                return {
                    sucesso: false,
                    status: error.response.status,
                    erro: `Erro HTTP ${error.response.status}`,
                    detalhes: error.response.data,
                    dados: error.response.data
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
     * Método helper para cancelar NFS-e (usa registrarEvento internamente)
     * 
     * @param {string} chaveAcesso - Chave de acesso da NFS-e
     * @param {string} cnpjEmpresa - CNPJ do emitente
     * @param {string} motivoCancelamento - Motivo do cancelamento (mín 15 caracteres)
     * @param {string} tipoAmbiente - 1=Produção, 2=Homologação
     * @param {string} versaoAplicacao - Versão do aplicativo (opcional)
     */
    static async cancelarNFSe(chaveAcesso, cnpjEmpresa, motivoCancelamento, tipoAmbiente, versaoAplicacao = 'NFSeAPI_v1.0') {
        try {
            console.log(`🚫 Iniciando cancelamento da NFS-e: ${chaveAcesso.substring(0, 20)}...`);
            
            // Valida motivo
            if (!motivoCancelamento || motivoCancelamento.length < 15) {
                throw new Error('Motivo do cancelamento deve ter no mínimo 15 caracteres');
            }
            
            // Monta dados do evento de cancelamento
            const dadosCancelamento = XMLEventoService.criarDadosCancelamento(
                chaveAcesso,
                cnpjEmpresa,
                motivoCancelamento,
                versaoAplicacao,
                tipoAmbiente
            );
            
            // Registra evento
            const resultado = await this.registrarEvento(
                chaveAcesso,
                dadosCancelamento,
                cnpjEmpresa,
                tipoAmbiente
            );
            
            if (resultado.sucesso) {
                console.log('✅ NFS-e cancelada com sucesso!');
            }
            
            return resultado;
            
        } catch (error) {
            console.error('❌ Erro no cancelamento:', error.message);
            return {
                sucesso: false,
                erro: error.message
            };
        }
    }

    /**
     * Lista transmissões de uma empresa com paginação
     */
    static async listarTransmissoes(cnpjEmpresa, pagina = 1, limite = 20) {
        const offset = (pagina - 1) * limite;
        
        const sql = `
            SELECT 
                t.id,
                t.id_dps,
                t.numero_dps,
                t.serie_dps,
                t.status_envio,
                t.codigo_retorno,
                t.mensagem_retorno,
                t.numero_protocolo,
                t.created_at,
                e.razao_social
            FROM nfse_transmissoes t
            INNER JOIN empresas e ON t.empresa_id = e.id
            WHERE e.cnpj = ?
            ORDER BY t.created_at DESC
            LIMIT ? OFFSET ?
        `;
        
        const results = await query(sql, [cnpjEmpresa, limite, offset]);
        
        // Conta total para paginação
        const sqlCount = `
            SELECT COUNT(*) as total
            FROM nfse_transmissoes t
            INNER JOIN empresas e ON t.empresa_id = e.id
            WHERE e.cnpj = ?
        `;
        
        const countResult = await query(sqlCount, [cnpjEmpresa]);
        const total = countResult[0].total;
        
        return {
            transmissoes: results,
            paginacao: {
                paginaAtual: pagina,
                limite,
                total,
                totalPaginas: Math.ceil(total / limite)
            }
        };
    }
}

module.exports = SefinService;