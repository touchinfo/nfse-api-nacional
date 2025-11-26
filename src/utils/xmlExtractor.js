const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');

/**
 * Utilitário para extrair e limpar elementos XML
 */
class XMLExtractor {

    /**
     * Extrai a NFSe completa sem as assinaturas e sem cabeçalho XML
     * @param {string} xmlCompleto - XML completo retornado pela SEFIN
     * @returns {string} - XML da NFSe limpo iniciando com <NFSe>
     */
    static extrairDPSLimpa(xmlCompleto) {
        try {
            console.log('🔍 Gerando XML Limpo (NFSe sem assinaturas)...');

            const parser = new DOMParser();
            const doc = parser.parseFromString(xmlCompleto, 'text/xml');

            // 1. Remove todas as assinaturas (ds:Signature e Signature)
            const signatures = doc.getElementsByTagName('ds:Signature');
            while (signatures.length > 0) {
                signatures[0].parentNode.removeChild(signatures[0]);
            }
            const signaturesNoNS = doc.getElementsByTagName('Signature');
            while (signaturesNoNS.length > 0) {
                signaturesNoNS[0].parentNode.removeChild(signaturesNoNS[0]);
            }

            // 2. Limpeza adicional (opcional): Remove xmlns redundante da DPS interna
            const dpsElements = doc.getElementsByTagName('DPS');
            if (dpsElements.length > 0) {
                const dps = dpsElements[0];
                if (dps.hasAttribute('xmlns')) {
                    dps.removeAttribute('xmlns');
                }
            }

            // 3. Serializa APENAS o elemento raiz (<NFSe>)
            const serializer = new XMLSerializer();
            // doc.documentElement é a tag <NFSe>
            let xmlLimpo = serializer.serializeToString(doc.documentElement); 

            // 4. NÃO adiciona o cabeçalho <?xml ... ?> 
            // O objetivo é começar direto com <NFSe ...>

            // 5. Formata para ficar legível
            return this.formatarXML(xmlLimpo);

        } catch (error) {
            console.error('Erro ao limpar XML:', error.message);
            // Em caso de erro, tenta retornar o original, mas removendo o header se existir
            return xmlCompleto.replace(/<\?xml.*?\?>\s*/, '');
        }
    }

    /**
     * Formata XML com indentação
     */
    static formatarXML(xml) {
        // Remove espaços em branco extras entre tags
        xml = xml.replace(/>\s+</g, '><');
        
        let formatted = '';
        let indent = 0;
        
        // Split mantém a estrutura, iteramos para identar
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

    // Mantendo métodos auxiliares existentes para compatibilidade
    static extrairInfDPS(xmlCompleto) {
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(xmlCompleto, 'text/xml');
            const infDPSElements = doc.getElementsByTagName('infDPS');
            if (infDPSElements.length === 0) throw new Error('Elemento infDPS não encontrado');
            const infDPSElement = infDPSElements[0];
            const signatures = infDPSElement.getElementsByTagName('ds:Signature');
            while (signatures.length > 0) signatures[0].parentNode.removeChild(signatures[0]);
            const serializer = new XMLSerializer();
            let infDPS = serializer.serializeToString(infDPSElement);
            // Neste caso mantemos o header pois é um fragmento isolado, ou remova se preferir
            infDPS = '<?xml version="1.0" encoding="UTF-8"?>\n' + infDPS;
            return this.formatarXML(infDPS);
        } catch (error) {
            console.error('Erro ao extrair infDPS:', error.message);
            throw error;
        }
    }

    static removerAssinaturas(xmlString) {
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(xmlString, 'text/xml');
            const signaturesDS = doc.getElementsByTagName('ds:Signature');
            while (signaturesDS.length > 0) signaturesDS[0].parentNode.removeChild(signaturesDS[0]);
            const signatures = doc.getElementsByTagName('Signature');
            while (signatures.length > 0) signatures[0].parentNode.removeChild(signatures[0]);
            const serializer = new XMLSerializer();
            return serializer.serializeToString(doc);
        } catch (error) {
            console.error('Erro ao remover assinaturas:', error.message);
            return xmlString;
        }
    }

    static extrairDadosDPS(xmlCompleto) {
        // ... (código existente mantido igual) ...
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
                prestador: { cnpj: getElementText('CNPJ') },
                tomador: { nome: getElementText('xNome') },
                valores: { vServ: getElementText('vServ'), pAliq: getElementText('pAliq') },
                descricaoServico: getElementText('xDescServ')
            };
        } catch (error) {
            return null;
        }
    }
}

module.exports = XMLExtractor;