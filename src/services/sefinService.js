const axios = require('axios');
const https = require('https');
const { query } = require('../config/database');
const CertificadoService = require('./certificadoService');

/**
 * Service para comunicação com a SEFIN Nacional
 */
class SefinService {

    /**
     * Retorna a URL da SEFIN baseada no ambiente
     */
    static getURLSefin(tipoAmbiente) {
        return tipoAmbiente === '1' 
            ? process.env.SEFIN_URL_PRODUCAO
            : process.env.SEFIN_URL_HOMOLOGACAO;
    }

    /**
     * Retorna a URL base da ADN (Ambiente de Disponibilização Nacional)
     */
    static getURLADN(tipoAmbiente) {
        return tipoAmbiente === '1'
            ? 'https://adn.producao.nfse.gov.br'
            : 'https://adn.producaorestrita.nfse.gov.br';
    }

    /**
     * Consulta os parâmetros de convênio de um município
     */
    static async consultarParametrosConvenio(codigoMunicipio, cnpjEmpresa, tipoAmbiente = '2') {
        try {
            console.log(`🔍 Consultando parâmetros de convênio do município ${codigoMunicipio}...`);
            
            // Busca certificado para mTLS
            console.log('  → Configurando certificado para autenticação mTLS...');
            const certInfo = await CertificadoService.buscarCertificadoPorCNPJ(cnpjEmpresa);
            
            // Extrai certificado em formato PEM
            const { privateKeyPem, certificatePem } = 
                CertificadoService.extrairCertificadoPEM(
                    certInfo.certificadoBuffer,
                    certInfo.senha
                );
            
            // Cria HTTPS Agent com o certificado (mTLS)
            const httpsAgent = new https.Agent({
                cert: certificatePem,
                key: privateKeyPem,
                rejectUnauthorized: tipoAmbiente === '1' // Mais rigoroso em produção
            });
            
            console.log('  → Certificado configurado para mTLS');
            
            // Monta URL da ADN
            const urlADN = this.getURLADN(tipoAmbiente);
            const urlCompleta = `${urlADN}/parametrizacao/${codigoMunicipio}/convenio`;
            
            console.log(`  → Consultando: ${urlCompleta}`);
            
            // Marca tempo de início
            const inicioConsulta = Date.now();
            
            // Envia requisição
            const response = await axios.get(
                urlCompleta,
                {
                    headers: {
                        'Accept': 'application/json'
                    },
                    httpsAgent: httpsAgent,
                    timeout: parseInt(process.env.SEFIN_TIMEOUT) || 30000
                }
            );
            
            const tempoProcessamento = Date.now() - inicioConsulta;
            
            console.log(`✅ Parâmetros obtidos com sucesso (${tempoProcessamento}ms)`);
            
            return {
                sucesso: true,
                status: response.status,
                dados: response.data,
                tempoProcessamento
            };
            
        } catch (error) {
            console.error('❌ Erro ao consultar parâmetros:', error.message);
            
            // Se a ADN retornou erro estruturado
            if (error.response) {
                return {
                    sucesso: false,
                    status: error.response.status,
                    dados: error.response.data,
                    erro: `Erro HTTP ${error.response.status}`,
                    detalhes: error.response.data
                };
            }
            
            // Erros de rede ou timeout
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
    static async enviarDPS(dpsXmlGZipB64, cnpjEmpresa, tipoAmbiente = '2') {
        try {
            console.log('📤 Enviando DPS para SEFIN Nacional...');
            
            // Busca certificado para mTLS
            console.log('  → Configurando certificado para autenticação mTLS...');
            const certInfo = await CertificadoService.buscarCertificadoPorCNPJ(cnpjEmpresa);
            
            // Extrai certificado em formato PEM
            const { privateKeyPem, certificatePem } = 
                CertificadoService.extrairCertificadoPEM(
                    certInfo.certificadoBuffer,
                    certInfo.senha
                );
            
            // Cria HTTPS Agent com o certificado (mTLS)
            const httpsAgent = new https.Agent({
                cert: certificatePem,
                key: privateKeyPem,
                rejectUnauthorized: tipoAmbiente === '1' // Mais rigoroso em produção
            });
            
            console.log('  → Certificado configurado para mTLS');
            
            // Monta URL da SEFIN
            const urlSefin = this.getURLSefin(tipoAmbiente);
            
            console.log(`  → Enviando para: ${urlSefin}`);
            
            // Marca tempo de início
            const inicioEnvio = Date.now();
            
            // Envia requisição
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
            
            console.log(`✅ Resposta recebida da SEFIN (${tempoProcessamento}ms)`);
            
            return {
                sucesso: true,
                status: response.status,
                dados: response.data,
                tempoProcessamento
            };
            
        } catch (error) {
            console.error('❌ Erro ao enviar para SEFIN:', error.message);
            
            // Se a SEFIN retornou erro estruturado
            if (error.response) {
                return {
                    sucesso: false,
                    status: error.response.status,
                    dados: error.response.data,
                    erro: `Erro HTTP ${error.response.status}`,
                    detalhes: error.response.data
                };
            }
            
            // Erros de rede ou timeout
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