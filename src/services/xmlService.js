const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const { SignedXml } = require('xml-crypto');
const zlib = require('zlib');
const xml2js = require('xml2js');
const CertificadoService = require('./certificadoService');
const ValidacaoXSDService = require('./validacaoXSDService');

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
            
            const prest = infDPS.prest || infDPS['ns:prest'];
            const cnpjPrestador = prest?.CNPJ || prest?.['ns:CNPJ'];
            
            if (!cnpjPrestador) {
                throw new Error('CNPJ do prestador não encontrado no XML');
            }
            
            const toma = infDPS.toma || infDPS['ns:toma'];
            const cnpjTomador = toma?.CNPJ || toma?.['ns:CNPJ'];
            
            const idDPS = infDPS['@']?.Id || infDPS['$']?.Id;
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
        
        if (infoDPS.cnpjPrestador === infoDPS.cnpjTomador) {
            erros.push({
                codigo: 'E0202',
                mensagem: 'CNPJ do prestador e tomador não podem ser iguais',
                campo: 'cnpjPrestador/cnpjTomador'
            });
        }
        
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
            
            const { privateKeyPem, certificatePem, certBase64 } = 
                CertificadoService.extrairCertificadoPEM(certificadoBuffer, senha);
            
            console.log('  → Extraindo ID do elemento infDPS...');
            
            const idMatch = xmlString.match(/Id="([^"]+)"/);
            if (!idMatch) {
                throw new Error('ID do elemento infDPS não encontrado no XML');
            }
            const idDPS = idMatch[1];
            
            console.log(`  → ID encontrado: ${idDPS}`);
            console.log('  → Configurando SignedXml...');
            
            const sig = new SignedXml({ 
                privateKey: privateKeyPem,
                publicCert: certificatePem,
                signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
                // Canonicalização Exclusiva (C14N) para evitar erro de namespace
                canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#' 
            });
            
            sig.addReference({
                xpath: `//*[@Id='${idDPS}']`,
                digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
                transforms: [
                    'http://www.w3.org/2001/10/xml-exc-c14n#'
                ]
            });
            
            sig.keyInfoProvider = {
                getKeyInfo: function() {
                    return `<KeyInfo><X509Data><X509Certificate>${certBase64}</X509Certificate></X509Data></KeyInfo>`;
                }
            };
            
            console.log('  → Computando assinatura...');
            
            sig.computeSignature(xmlString, {
                location: { reference: `//*[local-name()='infDPS']`, action: 'after' },
            });
            
            let signedXml = sig.getSignedXml();

            // --- CORREÇÃO DO CABEÇALHO (Fix System.Xml.XmlException) ---
            // Remove qualquer declaração XML existente (como <?xml version="2.0"...)
            // e força a versão correta 1.0
            signedXml = signedXml.replace(/<\?xml.*?\?>\s*/gi, '');
            signedXml = '<?xml version="1.0" encoding="UTF-8"?>' + signedXml;

            console.log('  ✓ XML assinado e cabeçalho corrigido!');
            
            return signedXml;
            
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

    static decodificarEDescomprimir(base64String) {
        try {
            const compressed = Buffer.from(base64String, 'base64');
            const decompressed = zlib.gunzipSync(compressed);
            return decompressed.toString('utf-8');
        } catch (error) {
            throw new Error(`Erro ao descomprimir: ${error.message}`);
        }
    }

    static async processarXML(xmlString, cnpjEmpresa) {
        console.log('📄 Iniciando processamento do XML...');
        
        console.log('  → Executando validação XSD completa...');
        const validacaoXSD = await ValidacaoXSDService.validarXMLCompleto(xmlString);
        
        if (!validacaoXSD.valido) {
            console.log('  ✗ Validação XSD falhou!');
            const errosFormatados = validacaoXSD.erros.map(erro => ({
                codigo: erro.codigo,
                mensagem: erro.mensagem,
                campo: erro.campo
            }));
            
            throw new Error(JSON.stringify({
                tipo: 'VALIDACAO_XSD',
                mensagem: 'XML não está em conformidade com o schema do emissor nacional',
                erros: errosFormatados,
                totalErros: errosFormatados.length
            }));
        }
        
        if (validacaoXSD.warnings && validacaoXSD.warnings.length > 0) {
            console.log('  ⚠️  Avisos de validação:');
            validacaoXSD.warnings.forEach(warning => {
                console.log(`     - ${warning.codigo}: ${warning.mensagem}`);
            });
        }
        
        console.log(`  ✓ Validação XSD concluída! (${validacaoXSD.tempoValidacao}ms)`);
        
        const infoDPS = {
            idDPS: validacaoXSD.dados.id,
            numeroDPS: validacaoXSD.dados.nDPS,
            serieDPS: validacaoXSD.dados.serie,
            cnpjPrestador: validacaoXSD.dados.cnpjPrestador,
            cnpjTomador: validacaoXSD.dados.cnpjTomador,
            cpfTomador: validacaoXSD.dados.cpfTomador
        };
        
        console.log('  → Validando CNPJ da empresa...');
        if (infoDPS.cnpjPrestador !== cnpjEmpresa) {
            throw new Error(
                `CNPJ do prestador no XML (${infoDPS.cnpjPrestador}) ` +
                `não corresponde ao CNPJ autenticado (${cnpjEmpresa})`
            );
        }
        
        console.log('  → Buscando certificado digital...');
        const certInfo = await CertificadoService.buscarCertificadoPorCNPJ(cnpjEmpresa);
        
        console.log('  → Assinando XML...');
        const xmlAssinado = this.assinarXML(
            xmlString,
            certInfo.certificadoBuffer,
            certInfo.senha
        );
        
        console.log('  → Comprimindo e codificando...');
        const dpsXmlGZipB64 = this.comprimirECodificar(xmlAssinado);
        
        console.log('✅ Processamento concluído!');
        
        return {
            infoDPS,
            xmlAssinado,
            dpsXmlGZipB64,
            empresaId: certInfo.empresaId,
            validacao: {
                tempoValidacao: validacaoXSD.tempoValidacao,
                warnings: validacaoXSD.warnings || []
            }
        };
    }
}

module.exports = XMLService;