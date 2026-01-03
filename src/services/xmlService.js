const { DOMParser } = require('@xmldom/xmldom');
const { SignedXml } = require('xml-crypto');
const zlib = require('zlib');
const xml2js = require('xml2js');
const CertificadoService = require('./certificadoService');
const ValidacaoXSDService = require('./validacaoXSDService');

class XMLService {
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
        cnpjPrestador: cnpjPrestador?._ ? cnpjPrestador._ : cnpjPrestador,
        cnpjTomador: cnpjTomador?._ ? cnpjTomador._ : cnpjTomador,
        xmlOriginal: xmlString
      };
    } catch (error) {
      throw new Error(`Erro ao extrair informações do XML: ${error.message}`);
    }
  }

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

  static assinarXML(xmlString, certificadoBuffer, senha) {
    try {
      console.log('  → Extraindo certificado e chave privada...');
      const { privateKeyPem, certificatePem, certBase64 } =
        CertificadoService.extrairCertificadoPEM(certificadoBuffer, senha);

      const idMatch = xmlString.match(/Id="([^"]+)"/);
      if (!idMatch) {
        throw new Error('ID do elemento infDPS não encontrado no XML');
      }
      const idDPS = idMatch[1];

      const sig = new SignedXml({
        privateKey: privateKeyPem,
        publicCert: certificatePem,
        signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
        canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#'
      });

      sig.addReference({
        xpath: `//*[@Id='${idDPS}']`,
        digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
        transforms: ['http://www.w3.org/2001/10/xml-exc-c14n#']
      });

      sig.keyInfoProvider = {
        getKeyInfo: function () {
          return `<KeyInfo><X509Data><X509Certificate>${certBase64}</X509Certificate></X509Data></KeyInfo>`;
        }
      };

      sig.computeSignature(xmlString, {
        location: { reference: `//*[local-name()='infDPS']`, action: 'after' },
      });

      let signedXml = sig.getSignedXml();

      // --- CORREÇÃO DO CABEÇALHO (Fix System.Xml.XmlException) ---
      signedXml = signedXml.replace(/<\?xml.*?\?>\s*/gi, '');
      signedXml = '<?xml version="1.0" encoding="UTF-8"?>' + signedXml;

      return signedXml;
    } catch (error) {
      console.error('  ✗ Erro ao assinar XML:', error);
      throw new Error(`Erro na assinatura: ${error.message}`);
    }
  }

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
    const validacaoXSD = await ValidacaoXSDService.validarXMLCompleto(xmlString);

    if (!validacaoXSD.valido) {
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

    const infoDPS = {
      idDPS: validacaoXSD.dados.id,
      numeroDPS: validacaoXSD.dados.nDPS,
      serieDPS: validacaoXSD.dados.serie,
      cnpjPrestador: validacaoXSD.dados.cnpjPrestador,
      cnpjTomador: validacaoXSD.dados.cnpjTomador,
      cpfTomador: validacaoXSD.dados.cpfTomador
    };

    if (infoDPS.cnpjPrestador !== cnpjEmpresa) {
      throw new Error(
        `CNPJ do prestador no XML (${infoDPS.cnpjPrestador}) ` +
        `não corresponde ao CNPJ autenticado (${cnpjEmpresa})`
      );
    }

    const certInfo = await CertificadoService.buscarCertificadoPorCNPJ(cnpjEmpresa);

    const xmlAssinado = this.assinarXML(
      xmlString,
      certInfo.certificadoBuffer,
      certInfo.senha
    );

    const dpsXmlGZipB64 = this.comprimirECodificar(xmlAssinado);

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