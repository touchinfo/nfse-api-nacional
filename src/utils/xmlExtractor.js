const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');

/**
 * Utilitário para extrair e limpar elementos XML
 */
class XMLExtractor {

    /**
     * Extrai apenas a DPS (sem assinatura) do XML completo da NFS-e
     * Remove as tags <ds:Signature> e retorna XML limpo
     * 
     * @param {string} xmlCompleto - XML completo retornado pela SEFIN
     * @returns {string} - XML da DPS limpo e formatado
     */
    static extrairDPSLimpa(xmlCompleto) {
        try {
            console.log('🔍 Extraindo DPS limpa do XML...');

            const parser = new DOMParser();
            const doc = parser.parseFromString(xmlCompleto, 'text/xml');

            // Busca o elemento DPS dentro do NFSe
            const dpsElements = doc.getElementsByTagName('DPS');
            
            if (dpsElements.length === 0) {
                throw new Error('Elemento DPS não encontrado no XML');
            }

            const dpsElement = dpsElements[0];

            // Remove todas as assinaturas (ds:Signature)
            const signatures = dpsElement.getElementsByTagName('ds:Signature');
            while (signatures.length > 0) {
                signatures[0].parentNode.removeChild(signatures[0]);
            }

            // Também remove <Signature> sem namespace
            const signaturesNoNS = dpsElement.getElementsByTagName('Signature');
            while (signaturesNoNS.length > 0) {
                signaturesNoNS[0].parentNode.removeChild(signaturesNoNS[0]);
            }

            // Serializa o elemento DPS limpo
            const serializer = new XMLSerializer();
            let dpsLimpa = serializer.serializeToString(dpsElement);

            // Adiciona declaração XML no início
            dpsLimpa = '<?xml version="1.0" encoding="UTF-8"?>\n' + dpsLimpa;

            // Formata o XML (opcional - deixa mais legível)
            dpsLimpa = this.formatarXML(dpsLimpa);

            console.log('✓ DPS extraída e limpa!');
            return dpsLimpa;

        } catch (error) {
            console.error('Erro ao extrair DPS:', error.message);
            throw error;
        }
    }

    /**
     * Formata XML com indentação (opcional)
     */
    static formatarXML(xml) {
        // Remove espaços em branco extras
        xml = xml.replace(/>\s+</g, '><');
        
        let formatted = '';
        let indent = 0;
        
        xml.split(/>\s*</).forEach(node => {
            if (node.match(/^\/\w/)) {
                indent--;
            }
            
            formatted += '  '.repeat(indent) + '<' + node + '>\n';
            
            if (node.match(/^<?\w[^>]*[^\/]$/) && !node.startsWith("?")) {
                indent++;
            }
        });
        
        return formatted
            .substring(1, formatted.length - 2)
            .replace(/>\n\s+</g, '>\n<')
            .trim();
    }

    /**
     * Extrai apenas o infDPS (dados principais sem envelope DPS)
     */
    static extrairInfDPS(xmlCompleto) {
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(xmlCompleto, 'text/xml');

            const infDPSElements = doc.getElementsByTagName('infDPS');
            
            if (infDPSElements.length === 0) {
                throw new Error('Elemento infDPS não encontrado');
            }

            const infDPSElement = infDPSElements[0];

            // Remove assinaturas
            const signatures = infDPSElement.getElementsByTagName('ds:Signature');
            while (signatures.length > 0) {
                signatures[0].parentNode.removeChild(signatures[0]);
            }

            const serializer = new XMLSerializer();
            let infDPS = serializer.serializeToString(infDPSElement);

            infDPS = '<?xml version="1.0" encoding="UTF-8"?>\n' + infDPS;

            return this.formatarXML(infDPS);

        } catch (error) {
            console.error('Erro ao extrair infDPS:', error.message);
            throw error;
        }
    }

    /**
     * Remove todos os elementos de assinatura de um XML
     */
    static removerAssinaturas(xmlString) {
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(xmlString, 'text/xml');

            // Remove ds:Signature
            const signaturesDS = doc.getElementsByTagName('ds:Signature');
            while (signaturesDS.length > 0) {
                signaturesDS[0].parentNode.removeChild(signaturesDS[0]);
            }

            // Remove Signature (sem namespace)
            const signatures = doc.getElementsByTagName('Signature');
            while (signatures.length > 0) {
                signatures[0].parentNode.removeChild(signatures[0]);
            }

            const serializer = new XMLSerializer();
            return serializer.serializeToString(doc);

        } catch (error) {
            console.error('Erro ao remover assinaturas:', error.message);
            return xmlString;
        }
    }

    /**
     * Extrai informações específicas da DPS em formato JSON
     */
    static extrairDadosDPS(xmlCompleto) {
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(xmlCompleto, 'text/xml');

            const getElementText = (tagName) => {
                const elements = doc.getElementsByTagName(tagName);
                return elements.length > 0 ? elements[0].textContent : null;
            };

            return {
                idDPS: doc.getElementsByTagName('infDPS')[0]?.getAttribute('Id'),
                nDPS: getElementText('nDPS'),
                serie: getElementText('serie'),
                dhEmi: getElementText('dhEmi'),
                dCompet: getElementText('dCompet'),
                prestador: {
                    cnpj: getElementText('CNPJ'), // Primeiro CNPJ é do prestador
                },
                tomador: {
                    nome: getElementText('xNome'),
                },
                valores: {
                    vServ: getElementText('vServ'),
                    pAliq: getElementText('pAliq'),
                },
                descricaoServico: getElementText('xDescServ')
            };

        } catch (error) {
            console.error('Erro ao extrair dados:', error.message);
            return null;
        }
    }
}

module.exports = XMLExtractor;