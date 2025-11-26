const html_to_pdf = require('html-pdf-node');

class DanfseService {

    /**
     * Gera um PDF (Buffer) a partir do XML da NFS-e
     * @param {string} xmlString - O XML descomprimido da nota
     * @returns {Promise<string>} - Retorna o PDF em Base64
     */
    static async gerarPDFBase64(xmlString) {
        try {
            console.log('📄 Gerando PDF da NFS-e...');

            // 1. Extrair dados básicos do XML para preencher o HTML
            // (Aqui é um exemplo simplificado regex/parse. O ideal é usar um parser XML real)
            const numeroNota = this.extrairTag(xmlString, 'nNFSe') || '000';
            const codigoVerificacao = this.extrairTag(xmlString, 'codVerificacao') || 'N/A';
            const prestador = this.extrairTag(xmlString, 'xNome', true); // true para pegar o primeiro (prestador)
            const valorTotal = this.extrairTag(xmlString, 'vLiq');

            // 2. Montar um HTML simples (Layout da Nota)
            // OBS: Para produção, você deve usar um template HTML completo da NFS-e Nacional
            const htmlContent = `
                <html>
                <head>
                    <style>
                        body { font-family: Arial, sans-serif; padding: 20px; }
                        .header { text-align: center; border-bottom: 2px solid #000; padding-bottom: 10px; }
                        .box { border: 1px solid #ccc; padding: 10px; margin-top: 10px; }
                        .title { font-weight: bold; font-size: 14px; background-color: #eee; padding: 5px; }
                        .value { font-size: 16px; margin-top: 5px; }
                    </style>
                </head>
                <body>
                    <div class="header">
                        <h1>NFS-e Nacional</h1>
                        <p>Nota Fiscal de Serviços Eletrônica</p>
                    </div>

                    <div class="box">
                        <div class="title">Número da Nota</div>
                        <div class="value">${numeroNota}</div>
                    </div>

                    <div class="box">
                        <div class="title">Código de Verificação</div>
                        <div class="value">${codigoVerificacao}</div>
                    </div>

                    <div class="box">
                        <div class="title">Prestador de Serviços</div>
                        <div class="value">${prestador}</div>
                    </div>

                    <div class="box">
                        <div class="title">Valor Líquido</div>
                        <div class="value">R$ ${valorTotal}</div>
                    </div>

                    <div class="box">
                        <div class="title">XML Original (Debug)</div>
                        <pre style="font-size: 8px; overflow: hidden;">${xmlString.substring(0, 200)}...</pre>
                    </div>
                    
                    <div style="margin-top: 20px; text-align: center; font-size: 12px; color: #666;">
                        Este é um modelo simplificado gerado pelo sistema.
                        Para o modelo oficial, consulte o Portal Nacional.
                    </div>
                </body>
                </html>
            `;

            // 3. Configurações do PDF
            const options = { format: 'A4' };
            const file = { content: htmlContent };

            // 4. Gerar PDF
            const pdfBuffer = await html_to_pdf.generatePdf(file, options);
            
            // Retorna em Base64 para enviar no JSON
            return pdfBuffer.toString('base64');

        } catch (error) {
            console.error('Erro ao gerar PDF:', error);
            return null; // Não trava o processo se falhar o PDF
        }
    }

    // Função auxiliar para ler XML sem biblioteca pesada
    static extrairTag(xml, tagName, firstOnly = false) {
        const regex = new RegExp(`<${tagName}>(.*?)<\/${tagName}>`, firstOnly ? '' : 'g');
        const match = regex.exec(xml);
        return match ? match[1] : null;
    }
}

module.exports = DanfseService;