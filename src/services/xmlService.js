const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const { SignedXml } = require('xml-crypto');
const zlib = require('zlib');
const xml2js = require('xml2js');
const CertificadoService = require('./certificadoService');

/**
 * Service para manipulação de XML da NFS-e
 */
class XMLService {

    /**
     * Valida se o XML enviado está bem formado
     */
    static validarXML(xmlString) {
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(xmlString, 'text/xml');
            
            // Verifica se há erros de parse
            const parseErrors = doc.getElementsByTagName('parsererror');
            if (parseErrors.length > 0) {
                throw new Error('XML mal formado');
            }
            
            return { valido: true };
        } catch (error) {
            return { 
                valido: false, 
                erro: error.message 
            };
        }
    }

    /**
     * Extrai informações importantes do XML da DPS
     */
    static async extrairInformacoesDPS(xmlString) {
        const parser = new xml2js.Parser({ 
            explicitArray: false,
            ignoreAttrs: false,
            attrkey: '@',
            charkey: '_'
        });
        
        try {
            const result = await parser.parseStringPromise(xmlString);
            const dps = result.DPS || result['ns:DPS'] || result;
            const infDPS = dps.infDPS || dps['ns:infDPS'];
            
            if (!infDPS) {
                throw new Error('Elemento infDPS não encontrado no XML');
            }
            
            // Extrai CNPJ do prestador
            const prest = infDPS.prest || infDPS['ns:prest'];
            const cnpjPrestador = prest?.CNPJ || prest?.['ns:CNPJ'];
            
            if (!cnpjPrestador) {
                throw new Error('CNPJ do prestador não encontrado no XML');
            }
            
            // Extrai CNPJ do tomador
            const toma = infDPS.toma || infDPS['ns:toma'];
            const cnpjTomador = toma?.CNPJ || toma?.['ns:CNPJ'];
            
            // Extrai ID da DPS
            const idDPS = infDPS['@']?.Id || infDPS['$']?.Id;
            
            // Extrai número e série
            const numeroDPS = infDPS.nDPS || infDPS['ns:nDPS'];
            const serieDPS = infDPS.serie || infDPS['ns:serie'];
            
            return {
                idDPS,
                numeroDPS,
                serieDPS,
                cnpjPrestador: cnpjPrestador?._? cnpjPrestador._ : cnpjPrestador,
                cnpjTomador: cnpjTomador?._? cnpjTomador._ : cnpjTomador,
                xmlOriginal: xmlString
            };
            
        } catch (error) {
            throw new Error(`Erro ao extrair informações do XML: ${error.message}`);
        }
    }

    /**
     * Valida regras de negócio da DPS
     */
    static validarRegrasDPS(infoDPS) {
        const erros = [];
        
        // Validação E0202: Prestador não pode ser igual ao tomador
        if (infoDPS.cnpjPrestador === infoDPS.cnpjTomador) {
            erros.push({
                codigo: 'E0202',
                mensagem: 'CNPJ do prestador e tomador não podem ser iguais',
                campo: 'cnpjPrestador/cnpjTomador'
            });
        }
        
        // Validação de CNPJ (14 dígitos)
        if (infoDPS.cnpjPrestador && infoDPS.cnpjPrestador.length !== 14) {
            erros.push({
                codigo: 'E0001',
                mensagem: 'CNPJ do prestador deve ter 14 dígitos',
                campo: 'cnpjPrestador'
            });
        }
        
        return {
            valido: erros.length === 0,
            erros
        };
    }

    /**
     * Assina o XML usando xml-crypto
     */
    static assinarXML(xmlString, certificadoBuffer, senha) {
        try {
            console.log('  → Extraindo certificado e chave privada...');
            
            // Extrai certificado em formato PEM
            const { privateKeyPem, certificatePem, certBase64 } = 
                CertificadoService.extrairCertificadoPEM(certificadoBuffer, senha);
            
            console.log('  → Extraindo ID do elemento infDPS...');
            
            // Extrai o ID do elemento infDPS
            const idMatch = xmlString.match(/Id="([^"]+)"/);
            if (!idMatch) {
                throw new Error('ID do elemento infDPS não encontrado no XML');
            }
            const idDPS = idMatch[1];
            
            console.log(`  → ID encontrado: ${idDPS}`);
            console.log('  → Configurando SignedXml...');
            
            // Cria instância do SignedXml
            const sig = new SignedXml({
                privateKey: privateKeyPem,
                publicCert: certificatePem,
                signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
                canonicalizationAlgorithm: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'
            });
            
            console.log('  → Adicionando referência ao elemento infDPS...');
            
            // Adiciona referência ao elemento infDPS
            sig.addReference({
                xpath: `//*[@Id='${idDPS}']`,
                digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
                transforms: [
                    'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
                    'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'
                ]
            });
            
            console.log('  → Configurando KeyInfo com certificado...');
            
            // Configura KeyInfo com o certificado
            sig.keyInfoProvider = {
                getKeyInfo: function() {
                    return `<ds:KeyInfo><ds:X509Data><ds:X509Certificate>${certBase64}</ds:X509Certificate></ds:X509Data></ds:KeyInfo>`;
                }
            };
            
            console.log('  → Computando assinatura...');
            
            // Computa a assinatura
            sig.computeSignature(xmlString, {
                location: { reference: `//*[local-name()='infDPS']`, action: 'after' },
                prefix: 'ds'
            });
            
            console.log('  ✓ XML assinado com sucesso!');
            
            // Retorna XML assinado
            return sig.getSignedXml();
            
        } catch (error) {
            console.error('  ✗ Erro ao assinar XML:', error);
            throw new Error(`Erro na assinatura: ${error.message}`);
        }
    }

    /**
     * Comprime e codifica em Base64 (GZIP)
     */
    static comprimirECodificar(xmlAssinado) {
        try {
            const compressed = zlib.gzipSync(Buffer.from(xmlAssinado, 'utf-8'));
            return compressed.toString('base64');
        } catch (error) {
            throw new Error(`Erro ao comprimir XML: ${error.message}`);
        }
    }

    /**
     * Descomprime Base64 GZIP para XML (útil para debug)
     */
    static decodificarEDescomprimir(base64String) {
        try {
            const compressed = Buffer.from(base64String, 'base64');
            const decompressed = zlib.gunzipSync(compressed);
            return decompressed.toString('utf-8');
        } catch (error) {
            throw new Error(`Erro ao descomprimir: ${error.message}`);
        }
    }

    /**
     * Processo completo: valida, assina e comprime
     */
    static async processarXML(xmlString, cnpjEmpresa) {
        console.log('📄 Iniciando processamento do XML...');
        
        // 1. Valida XML
        console.log('  → Validando XML...');
        const validacao = this.validarXML(xmlString);
        if (!validacao.valido) {
            throw new Error(`XML inválido: ${validacao.erro}`);
        }
        
        // 2. Extrai informações
        console.log('  → Extraindo informações da DPS...');
        const infoDPS = await this.extrairInformacoesDPS(xmlString);
        
        // 3. Valida CNPJ da empresa com o XML
        if (infoDPS.cnpjPrestador !== cnpjEmpresa) {
            throw new Error(
                `CNPJ do prestador no XML (${infoDPS.cnpjPrestador}) ` +
                `não corresponde ao CNPJ autenticado (${cnpjEmpresa})`
            );
        }
        
        // 4. Valida regras de negócio
        console.log('  → Validando regras de negócio...');
        const validacaoRegras = this.validarRegrasDPS(infoDPS);
        if (!validacaoRegras.valido) {
            throw new Error(
                `Erro de validação: ${JSON.stringify(validacaoRegras.erros)}`
            );
        }
        
        // 5. Busca certificado da empresa
        console.log('  → Buscando certificado digital...');
        const certInfo = await CertificadoService.buscarCertificadoPorCNPJ(cnpjEmpresa);
        
        // 6. Assina o XML
        console.log('  → Assinando XML...');
        const xmlAssinado = this.assinarXML(
            xmlString,
            certInfo.certificadoBuffer,
            certInfo.senha
        );
        
        // 7. Comprime e codifica
        console.log('  → Comprimindo e codificando...');
        const dpsXmlGZipB64 = this.comprimirECodificar(xmlAssinado);
        
        console.log('✅ Processamento concluído!');
        
        return {
            infoDPS,
            xmlAssinado,
            dpsXmlGZipB64,
            empresaId: certInfo.empresaId
        };
    }
}

module.exports = XMLService;