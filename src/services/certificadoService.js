const forge = require('node-forge');
const CryptoJS = require('crypto-js');
const { query } = require('../config/database');

/**
 * Service para gerenciar certificados digitais A1
 */
class CertificadoService {
    
    /**
     * Criptografa a senha do certificado usando AES-256
     */
    static encryptSenha(senha) {
        const key = process.env.ENCRYPTION_KEY;
        if (!key || key.length !== 64) {
            throw new Error('ENCRYPTION_KEY deve ter 64 caracteres (32 bytes em hex)');
        }
        return CryptoJS.AES.encrypt(senha, key).toString();
    }

    /**
     * Descriptografa a senha do certificado
     */
    static decryptSenha(senhaEncrypted) {
        const key = process.env.ENCRYPTION_KEY;
        const bytes = CryptoJS.AES.decrypt(senhaEncrypted, key);
        return bytes.toString(CryptoJS.enc.Utf8);
    }

    /**
     * Valida e extrai informações do certificado .pfx/.p12
     */
    static validarCertificado(certificadoBuffer, senha) {
        try {
            // Converte buffer para binary string
            const p12Der = certificadoBuffer.toString('binary');
            const p12Asn1 = forge.asn1.fromDer(p12Der);
            
            // Tenta abrir com a senha fornecida
            const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, senha);
            
            // Extrai o certificado
            const bags = p12.getBags({ bagType: forge.pki.oids.certBag });
            const certBag = bags[forge.pki.oids.certBag][0];
            const certificate = certBag.cert;
            
            // Extrai informações do subject
            const subject = certificate.subject.attributes.reduce((acc, attr) => {
                acc[attr.shortName] = attr.value;
                return acc;
            }, {});
            
            // Extrai informações do issuer
            const issuer = certificate.issuer.attributes.reduce((acc, attr) => {
                acc[attr.shortName] = attr.value;
                return acc;
            }, {});
            
            // Extrai CNPJ do serialNumber (geralmente está no formato: CNPJ + número)
            let cnpj = null;
            if (subject.serialNumber) {
                // Remove tudo que não é número
                const numeros = subject.serialNumber.replace(/\D/g, '');
                // CNPJ tem 14 dígitos
                if (numeros.length >= 14) {
                    cnpj = numeros.substring(0, 14);
                }
            }
            
            return {
                valido: true,
                titular: subject.CN || 'N/A',
                cnpj: cnpj,
                emissor: issuer.CN || 'N/A',
                validadeInicio: certificate.validity.notBefore,
                validadeFim: certificate.validity.notAfter,
                certificadoValido: new Date() < certificate.validity.notAfter,
                diasRestantes: Math.ceil((certificate.validity.notAfter - new Date()) / (1000 * 60 * 60 * 24))
            };
            
        } catch (error) {
            return {
                valido: false,
                erro: 'Certificado inválido ou senha incorreta',
                detalhes: error.message
            };
        }
    }

    /**
     * Busca o certificado de uma empresa pelo CNPJ
     */
    static async buscarCertificadoPorCNPJ(cnpj) {
        const sql = `
            SELECT 
                id,
                cnpj,
                certificado_pfx,
                senha_certificado_encrypted,
                certificado_validade,
                ativa
            FROM empresas
            WHERE cnpj = ? AND ativa = TRUE
        `;
        
        const results = await query(sql, [cnpj]);
        
        if (results.length === 0) {
            throw new Error('Empresa não encontrada ou inativa');
        }
        
        const empresa = results[0];
        
        // Verifica validade do certificado
        const hoje = new Date();
        const validade = new Date(empresa.certificado_validade);
        
        if (hoje > validade) {
            throw new Error('Certificado digital vencido. Atualize o certificado da empresa.');
        }
        
        // Descriptografa a senha
        const senhaDecrypted = this.decryptSenha(empresa.senha_certificado_encrypted);
        
        return {
            empresaId: empresa.id,
            cnpj: empresa.cnpj,
            certificadoBuffer: empresa.certificado_pfx,
            senha: senhaDecrypted,
            validade: empresa.certificado_validade
        };
    }

    /**
     * Extrai certificado e chave privada em formato PEM
     */
    static extrairCertificadoPEM(certificadoBuffer, senha) {
        try {
            const p12Der = certificadoBuffer.toString('binary');
            const p12Asn1 = forge.asn1.fromDer(p12Der);
            const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, senha);
            
            // Extrai certificado
            const bags = p12.getBags({ bagType: forge.pki.oids.certBag });
            const certBag = bags[forge.pki.oids.certBag][0];
            const certificate = certBag.cert;
            
            // Extrai chave privada
            const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
            const keyBag = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag][0];
            const privateKey = keyBag.key;
            
            // Converte para PEM
            const privateKeyPem = forge.pki.privateKeyToPem(privateKey);
            const certificatePem = forge.pki.certificateToPem(certificate);
            
            // Certificado em Base64 (sem headers)
            const certBase64 = certificatePem
                .replace(/-----BEGIN CERTIFICATE-----/g, '')
                .replace(/-----END CERTIFICATE-----/g, '')
                .replace(/\n/g, '');
            
            return {
                privateKeyPem,
                certificatePem,
                certBase64
            };
            
        } catch (error) {
            throw new Error(`Erro ao extrair certificado PEM: ${error.message}`);
        }
    }

    /**
     * Verifica se o certificado está próximo do vencimento
     */
    static async verificarCertificadosProximosVencimento(diasAlerta = 30) {
        const sql = `
            SELECT 
                id,
                cnpj,
                razao_social,
                certificado_validade,
                DATEDIFF(certificado_validade, CURDATE()) as dias_restantes
            FROM empresas
            WHERE ativa = TRUE
            AND DATEDIFF(certificado_validade, CURDATE()) <= ?
            AND DATEDIFF(certificado_validade, CURDATE()) >= 0
            ORDER BY certificado_validade ASC
        `;
        
        return await query(sql, [diasAlerta]);
    }
}

module.exports = CertificadoService;