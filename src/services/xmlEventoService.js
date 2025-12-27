const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const { SignedXml } = require('xml-crypto');
const zlib = require('zlib');
const CertificadoService = require('./certificadoService');

/**
 * Service para geração de XML de Eventos NFS-e Nacional
 * Conforme XSD oficial: pedRegEvento_v1.01.xsd
 */
class XMLEventoService {

    static NAMESPACE = 'http://www.sped.fazenda.gov.br/nfse';
    static VERSAO = '1.01';

    /**
     * Gera XML de pedido de registro de evento de cancelamento
     * Estrutura: pedRegEvento > infPedReg > e101101
     */
    static montarXMLCancelamento(dados) {
        const {
            chaveAcesso,      // 50 dígitos
            cnpjAutor,        // 14 dígitos
            codigoMotivo,     // 1-9 (TSCodJustCanc)
            motivoTexto,      // Descrição livre
            tipoAmbiente,     // 1=Prod, 2=Homolog
            versaoAplicacao   // Ex: "NFSeAPI_v1.0"
        } = dados;

        // Validações
        if (!chaveAcesso || chaveAcesso.length !== 50) {
            throw new Error('Chave de acesso deve ter 50 dígitos');
        }
        if (!cnpjAutor || cnpjAutor.length !== 14) {
            throw new Error('CNPJ do autor deve ter 14 dígitos');
        }
        if (!codigoMotivo || codigoMotivo < 1 || codigoMotivo > 9) {
            throw new Error('Código do motivo deve ser entre 1 e 9');
        }

        const agora = new Date();
        const dhEvento = this.formatarDataHora(agora);
        
        // ID conforme padrão: PRE + chNFSe(50) + tpEvento(6) + nSeqEvento(3)
        // Exemplo: PRE431490222YYYYYYYYYYYYYY000000000001825060784034730101101001
        const idPedReg = `PRE${chaveAcesso}101101001`;

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<pedRegEvento xmlns="${this.NAMESPACE}" versao="${this.VERSAO}">
    <infPedReg Id="${idPedReg}">
        <tpAmb>${tipoAmbiente}</tpAmb>
        <verAplic>${versaoAplicacao || 'NFSeAPI_v1.0'}</verAplic>
        <dhEvento>${dhEvento}</dhEvento>
        <CNPJAutor>${cnpjAutor}</CNPJAutor>
        <chNFSe>${chaveAcesso}</chNFSe>
        <nPedRegEvento>1</nPedRegEvento>
        <e101101>
            <xDesc>Cancelamento de NFS-e</xDesc>
            <cMotivo>${codigoMotivo}</cMotivo>
            <xMotivo>${this.escaparXML(motivoTexto)}</xMotivo>
        </e101101>
    </infPedReg>
</pedRegEvento>`;

        return xml;
    }

    /**
     * Assina o XML do pedido de registro de evento
     * Assinatura no elemento infPedReg (Id="PRE...")
     */
    static assinarXMLEvento(xmlString, certificadoBuffer, senha) {
        try {
            console.log('  → Extraindo certificado para assinatura de evento...');
            
            const { privateKeyPem, certificatePem, certBase64 } = 
                CertificadoService.extrairCertificadoPEM(certificadoBuffer, senha);

            // Extrair o ID do infPedReg (formato: Id="ID...")
            const idMatch = xmlString.match(/Id="([^"]+)"/);
            if (!idMatch) {
                throw new Error('ID do elemento infPedReg não encontrado');
            }
            const idPedReg = idMatch[1];

            console.log(`  → ID do pedido: ${idPedReg}`);

            const sig = new SignedXml({
                privateKey: privateKeyPem,
                publicCert: certificatePem,
                signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
                canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#'
            });

            sig.addReference({
                xpath: `//*[@Id='${idPedReg}']`,
                digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
                transforms: [
                    'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
                    'http://www.w3.org/2001/10/xml-exc-c14n#'
                ]
            });

            sig.keyInfoProvider = {
                getKeyInfo: function() {
                    return `<KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>${certBase64}</X509Certificate></X509Data></KeyInfo>`;
                }
            };

            console.log('  → Computando assinatura...');

            sig.computeSignature(xmlString, {
                location: { reference: `//*[local-name()='infPedReg']`, action: 'after' }
            });

            let signedXml = sig.getSignedXml();

            // Corrige cabeçalho XML
            signedXml = signedXml.replace(/<\?xml.*?\?>\s*/gi, '');
            signedXml = '<?xml version="1.0" encoding="UTF-8"?>' + signedXml;

            console.log('  ✓ XML do evento assinado!');

            return signedXml;

        } catch (error) {
            console.error('  ✗ Erro ao assinar XML do evento:', error);
            throw new Error(`Erro na assinatura do evento: ${error.message}`);
        }
    }

    /**
     * Comprime e codifica em Base64 (GZIP)
     */
    static comprimirECodificar(xmlAssinado) {
        const compressed = zlib.gzipSync(Buffer.from(xmlAssinado, 'utf-8'));
        return compressed.toString('base64');
    }

    /**
     * Processa cancelamento completo: monta XML, assina e comprime
     */
    static async processarCancelamento(dados, cnpjEmpresa) {
        console.log('📝 Processando evento de cancelamento...');

        // 1. Busca certificado
        console.log('  → Buscando certificado...');
        const certInfo = await CertificadoService.buscarCertificadoPorCNPJ(cnpjEmpresa);

        // 2. Monta XML
        console.log('  → Montando XML do evento...');
        const xmlEvento = this.montarXMLCancelamento({
            ...dados,
            cnpjAutor: cnpjEmpresa
        });

        // 3. Assina
        console.log('  → Assinando XML...');
        const xmlAssinado = this.assinarXMLEvento(
            xmlEvento,
            certInfo.certificadoBuffer,
            certInfo.senha
        );

        // 4. Comprime
        console.log('  → Comprimindo...');
        const eventoXmlGZipB64 = this.comprimirECodificar(xmlAssinado);

        console.log('✅ Evento de cancelamento processado!');

        return {
            xmlOriginal: xmlEvento,
            xmlAssinado,
            eventoXmlGZipB64,
            chaveAcesso: dados.chaveAcesso,
            tipoEvento: '101101'
        };
    }

    /**
     * Formata data/hora no padrão ISO com timezone de Brasília
     * Formato: 2025-07-07T10:52:56-03:00
     */
    static formatarDataHora(data) {
        const pad = (n) => n.toString().padStart(2, '0');
        
        // Calcula horário de Brasília (UTC-3)
        const utcMs = data.getTime() + (data.getTimezoneOffset() * 60000);
        const brasiliaMs = utcMs - (3 * 3600000);
        const dataBrasilia = new Date(brasiliaMs);
        
        const ano = dataBrasilia.getUTCFullYear();
        const mes = pad(dataBrasilia.getUTCMonth() + 1);
        const dia = pad(dataBrasilia.getUTCDate());
        const hora = pad(dataBrasilia.getUTCHours());
        const min = pad(dataBrasilia.getUTCMinutes());
        const seg = pad(dataBrasilia.getUTCSeconds());
        
        return `${ano}-${mes}-${dia}T${hora}:${min}:${seg}-03:00`;
    }

    /**
     * Escapa caracteres especiais XML
     */
    static escaparXML(texto) {
        if (!texto) return '';
        return texto
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    /**
     * Códigos de justificativa de cancelamento (TSCodJustCanc)
     */
    static CODIGOS_CANCELAMENTO = {
        1: 'Erro na emissão',
        2: 'Serviço não prestado',
        3: 'Erro de assinatura',
        4: 'Duplicidade da nota',
        5: 'Erro de processamento',
        9: 'Outros'
    };

    /**
     * Códigos de motivo de substituição
     */
    static CODIGOS_SUBSTITUICAO = {
        1: 'Erro no valor do serviço',
        2: 'Erro nos dados do tomador',
        3: 'Erro na descrição do serviço',
        4: 'Erro na tributação',
        9: 'Outros'
    };

    /**
     * Gera XML de pedido de registro de evento de SUBSTITUIÇÃO
     * Evento: e105102 (Substituição de NFS-e)
     * 
     * @param {Object} dados
     * @param {string} dados.chaveAcesso - Chave da NFS-e a ser substituída (50 dígitos)
     * @param {string} dados.chaveSubstituta - Chave da nova NFS-e substituta (50 dígitos)
     * @param {string} dados.cnpjAutor - CNPJ do autor do evento (14 dígitos)
     * @param {number} dados.codigoMotivo - Código do motivo (1-9)
     * @param {string} dados.motivoTexto - Descrição do motivo
     * @param {string} dados.tipoAmbiente - 1=Prod, 2=Homolog
     * @param {string} dados.versaoAplicacao - Ex: "NFSeAPI_v1.0"
     */
    static montarXMLSubstituicao(dados) {
        const {
            chaveAcesso,      // Chave da NFS-e ORIGINAL (a ser substituída)
            chaveSubstituta,  // Chave da NFS-e NOVA (substituta)
            cnpjAutor,
            codigoMotivo,
            motivoTexto,
            tipoAmbiente,
            versaoAplicacao
        } = dados;

        // Validações
        if (!chaveAcesso || chaveAcesso.length !== 50) {
            throw new Error('Chave de acesso da NFS-e original deve ter 50 dígitos');
        }
        if (!chaveSubstituta || chaveSubstituta.length !== 50) {
            throw new Error('Chave de acesso da NFS-e substituta deve ter 50 dígitos');
        }
        if (!cnpjAutor || cnpjAutor.length !== 14) {
            throw new Error('CNPJ do autor deve ter 14 dígitos');
        }
        if (!codigoMotivo || codigoMotivo < 1 || codigoMotivo > 9) {
            throw new Error('Código do motivo deve ser entre 1 e 9');
        }

        const agora = new Date();
        const dhEvento = this.formatarDataHora(agora);
        
        // ID: PRE + chNFSe(50) + tpEvento(6) + nSeqEvento(3)
        // tpEvento para substituição = 105102
        const idPedReg = `PRE${chaveAcesso}105102001`;

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<pedRegEvento xmlns="${this.NAMESPACE}" versao="${this.VERSAO}">
    <infPedReg Id="${idPedReg}">
        <tpAmb>${tipoAmbiente}</tpAmb>
        <verAplic>${versaoAplicacao || 'NFSeAPI_v1.0'}</verAplic>
        <dhEvento>${dhEvento}</dhEvento>
        <CNPJAutor>${cnpjAutor}</CNPJAutor>
        <chNFSe>${chaveAcesso}</chNFSe>
        <nPedRegEvento>1</nPedRegEvento>
        <e105102>
            <xDesc>Substituição de NFS-e</xDesc>
            <cMotivo>${codigoMotivo}</cMotivo>
            <xMotivo>${this.escaparXML(motivoTexto)}</xMotivo>
            <chSubstituta>${chaveSubstituta}</chSubstituta>
        </e105102>
    </infPedReg>
</pedRegEvento>`;

        return xml;
    }

    /**
     * Processa substituição completa: monta XML, assina e comprime
     * 
     * FLUXO DE SUBSTITUIÇÃO:
     * 1. Primeiro emita a nova NFS-e (que será a substituta)
     * 2. Depois chame este método passando a chave da nota original e da nova
     * 3. O sistema registrará o evento de substituição na nota original
     */
    static async processarSubstituicao(dados, cnpjEmpresa) {
        console.log('📝 Processando evento de substituição...');
        console.log(`   NFS-e Original: ${dados.chaveAcesso}`);
        console.log(`   NFS-e Substituta: ${dados.chaveSubstituta}`);

        // 1. Busca certificado
        console.log('  → Buscando certificado...');
        const certInfo = await CertificadoService.buscarCertificadoPorCNPJ(cnpjEmpresa);

        // 2. Monta XML
        console.log('  → Montando XML do evento de substituição...');
        const xmlEvento = this.montarXMLSubstituicao({
            ...dados,
            cnpjAutor: cnpjEmpresa
        });

        // 3. Assina
        console.log('  → Assinando XML...');
        const xmlAssinado = this.assinarXMLEvento(
            xmlEvento,
            certInfo.certificadoBuffer,
            certInfo.senha
        );

        // 4. Comprime
        console.log('  → Comprimindo...');
        const eventoXmlGZipB64 = this.comprimirECodificar(xmlAssinado);

        console.log('✅ Evento de substituição processado!');

        return {
            xmlOriginal: xmlEvento,
            xmlAssinado,
            eventoXmlGZipB64,
            chaveAcesso: dados.chaveAcesso,
            chaveSubstituta: dados.chaveSubstituta,
            tipoEvento: '105102'
        };
    }
}

module.exports = XMLEventoService;