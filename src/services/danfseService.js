const { PDFDocument } = require('pdf-lib');
const QRCode = require('qrcode');
const fs = require('fs').promises;
const path = require('path');

/**
 * Service para geração de DANFSE - LÊ PDFs DE ARQUIVOS
 * Muito mais simples e organizado que Base64!
 */
class DanfseService {
    
    constructor() {
        // Diretórios
        this.templatesDir = path.join(process.cwd(), 'config', 'templates');
        this.logosDir = path.join(process.cwd(), 'config', 'logos-prefeitura');
        
        // Caminhos dos templates
        this.templatePaths = {
            normal: path.join(this.templatesDir, 'danfse-normal.pdf'),
            cancelado: path.join(this.templatesDir, 'danfse-cancelado.pdf'),
            substituido: path.join(this.templatesDir, 'danfse-substituido.pdf')
        };
    }

    /**
     * Gera o DANFSE a partir dos dados fornecidos
     */
    async gerar(dados, isCancelled = false, isSubst = false) {
        try {
            console.log('📄 Gerando DANFSE...');
            
            // Seleciona o template
            let templatePath;
            
            if (isSubst) {
                templatePath = this.templatePaths.substituido;
            } else if (isCancelled) {
                templatePath = this.templatePaths.cancelado;
            } else {
                templatePath = this.templatePaths.normal;
            }

            // Verifica se existe
            try {
                await fs.access(templatePath);
            } catch {
                throw new Error(`Template não encontrado: ${templatePath}`);
            }

            // Lê o PDF
            const pdfBytes = await fs.readFile(templatePath);
            console.log(`   Template: ${path.basename(templatePath)}`);

            // Carrega
            const pdfDoc = await PDFDocument.load(pdfBytes);
            const form = pdfDoc.getForm();

            // Preenche
            this.preencherCampos(form, dados);
            form.flatten();

            // Adiciona QR Code e Logo
            if (dados.ChaveAcesso) {
                await this.adicionarQRCode(pdfDoc, dados.ChaveAcesso);
            }
            
            if (dados.cMunicipioPrestador) {
                await this.adicionarLogoPrefeitura(pdfDoc, dados.cMunicipioPrestador);
            }

            // Salva
            const pdfBytesOutput = await pdfDoc.save();
            
            console.log('✅ DANFSE gerado com sucesso!');
            
            return Buffer.from(pdfBytesOutput);
            
        } catch (error) {
            console.error('❌ Erro ao gerar DANFSE:', error);
            throw new Error(`Erro ao gerar DANFSE: ${error.message}`);
        }
    }

    preencherCampos(form, dados) {
        // Identificação
        this.setField(form, 'chave_acesso', dados.ChaveAcesso);
        this.setField(form, 'numero_nfse', dados.NumeroNfse);
        this.setField(form, 'competencia_nfse', this.formatarData(dados.Competencia));
        this.setField(form, 'data_hora_emissao_nfse', this.formatarDataHora(dados.DataHoraEmissaoNfse));
        this.setField(form, 'numero_dps', dados.NumeroDps);
        this.setField(form, 'serie_dps', dados.SerieDps);
        this.setField(form, 'data_hora_emissao_dps', this.formatarDataHora(dados.DataHoraEmissaoDps));

        // Prestador
        this.setField(form, 'cnpj_prestador', this.formatarCnpj(dados.CnpjPrestador));
        this.setField(form, 'im_prestador', dados.InscricaoMunicipalPrestador || '-');
        this.setField(form, 'telefone_prestador', dados.TelefonePrestador || '-');
        this.setField(form, 'nome_prestador', dados.NomePrestador);
        this.setField(form, 'email_prestador', dados.EmailPrestador || '-');
        this.setField(form, 'endereco_prestador', dados.EnderecoPrestador || '-');
        this.setField(form, 'municipio_prestador', `${dados.MunicipioPrestador || ''} - ${dados.UfPrestador || ''}`);
        this.setField(form, 'cep_prestador', this.formatarCep(dados.CepPrestador));
        this.setField(form, 'simples_nacional', dados.DescricaoSimplesNacional || '-');
        this.setField(form, 'regime_apuracao', dados.DescricaoRegimeApuracao || '-');

        // Tomador
        this.setField(form, 'cnpj_tomador', this.formatarDocumento(dados.DocumentoTomador));
        this.setField(form, 'im_tomador', dados.InscricaoMunicipalTomador || '-');
        this.setField(form, 'telefone_tomador', dados.TelefoneTomador || '-');
        this.setField(form, 'nome_tomador', dados.NomeTomador || '-');
        this.setField(form, 'email_tomador', dados.EmailTomador || '-');
        this.setField(form, 'endereco_tomador', dados.EnderecoTomador || '-');
        this.setField(form, 'municipio_tomador', dados.MunicipioTomador || '-');
        this.setField(form, 'cep_tomador', this.formatarCep(dados.CepTomador) || '-');

        // Serviço
        this.setField(form, 'cod_trib_nacional', dados.CodigoTributacaoNacional || '-');
        this.setField(form, 'cod_trib_municipal', dados.CodigoTributacaoMunicipal || '-');
        this.setField(form, 'local_prestacao', dados.LocalPrestacao || '-');
        this.setField(form, 'pais_prestacao', dados.PaisPrestacao || '-');
        this.setField(form, 'descricao_servico', dados.DescricaoServico || '-');

        // Tributação Municipal
        this.setField(form, 'tributacao_issqn', dados.TributacaoIssqn || 'Operação Tributável');
        this.setField(form, 'pais_resultado', dados.PaisResultado || '-');
        this.setField(form, 'municipio_incidencia', dados.MunicipioIncidencia || '-');
        this.setField(form, 'regime_especial', dados.RegimeEspecialTributacao || 'Nenhum');
        this.setField(form, 'tipo_imunidade', dados.TipoImunidade || '-');
        this.setField(form, 'suspensao_issqn', dados.SuspensaoIssqn || 'Não');
        this.setField(form, 'num_processo_suspensao', dados.NumeroProcessoSuspensao || '-');
        this.setField(form, 'beneficio_municipal', dados.BeneficioMunicipal || '-');
        this.setField(form, 'valor_servico_trib', this.formatarMoeda(dados.ValorServico));
        this.setField(form, 'desconto_incond_trib', this.formatarMoeda(dados.DescontoIncondicionado));
        this.setField(form, 'total_deducoes', this.formatarMoeda(dados.TotalDeducoes));
        this.setField(form, 'calculo_bm', dados.CalculoBM || '-');
        this.setField(form, 'bc_issqn', this.formatarMoeda(dados.BaseCalculoIssqn));
        this.setField(form, 'aliquota_aplicada', dados.Aliquota > 0 ? `${dados.Aliquota.toFixed(2)}%` : '-');
        this.setField(form, 'retencao_issqn', dados.RetencaoIssqn || 'Não Retido');
        this.setField(form, 'issqn_apurado', this.formatarMoeda(dados.IssqnApurado));

        // Tributação Federal
        this.setField(form, 'irrf', this.formatarMoeda(dados.ValorIrrf));
        this.setField(form, 'cp', this.formatarMoeda(dados.ValorCp));
        this.setField(form, 'csll', this.formatarMoeda(dados.ValorCsll));
        this.setField(form, 'pis', this.formatarMoeda(dados.ValorPis));
        this.setField(form, 'cofins', this.formatarMoeda(dados.ValorCofins));
        this.setField(form, 'retencao_pis_cofins', dados.RetencaoPisCofins || '-');
        this.setField(form, 'total_trib_federal', this.formatarMoeda(dados.TotalTributosFederais));

        // Valor Total
        this.setField(form, 'valor_servico_total', this.formatarMoeda(dados.ValorServico));
        this.setField(form, 'desconto_condicionado', this.formatarMoeda(dados.DescontoCondicionado, 'R$'));
        this.setField(form, 'desconto_incond_total', this.formatarMoeda(dados.DescontoIncondicionado, 'R$'));
        this.setField(form, 'issqn_retido', this.formatarMoeda(dados.IssqnRetido));
        this.setField(form, 'irrf_cp_csll_retidos', this.formatarMoeda((dados.ValorCsll || 0) + (dados.ValorIrrf || 0) + (dados.ValorCp || 0)));
        this.setField(form, 'pis_cofins_retidos', this.formatarMoeda(dados.PisCofinsRetidos));
        this.setField(form, 'valor_liquido', this.formatarMoeda(dados.ValorLiquido));

        // Totais Tributos
        this.setField(form, 'tributos_federais', this.formatarMoeda(dados.TotalTributacaoFederal));
        this.setField(form, 'tributos_estaduais', this.formatarMoeda(dados.TotalTributosEstaduais));
        this.setField(form, 'tributos_municipais', this.formatarMoeda(dados.TotalTributosMunicipais));

        // Informações Complementares
        this.setField(form, 'info_complementares', dados.InformacoesComplementares || '');
    }

    setField(form, fieldName, value) {
        try {
            const field = form.getTextField(fieldName);
            field.setText(String(value || ''));
        } catch (error) {
            // Campo não existe, ignora
        }
    }

    async adicionarQRCode(pdfDoc, chaveAcesso) {
        try {
            const url = `https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=${chaveAcesso}`;
            const qrCodeBuffer = await QRCode.toBuffer(url, {
                errorCorrectionLevel: 'M',
                type: 'png',
                width: 200,
                margin: 1
            });

            const qrImage = await pdfDoc.embedPng(qrCodeBuffer);
            const pages = pdfDoc.getPages();
            const firstPage = pages[0];

            firstPage.drawImage(qrImage, {
                x: 480,
                y: 745,
                width: 50,
                height: 50
            });
        } catch (error) {
            console.error(`⚠️ Erro ao adicionar QR Code: ${error.message}`);
        }
    }

    async adicionarLogoPrefeitura(pdfDoc, cMunicipio) {
        try {
            let logoPath = path.join(this.logosDir, `${cMunicipio}.jpg`);
            let isPng = false;

            try {
                await fs.access(logoPath);
            } catch {
                logoPath = path.join(this.logosDir, `${cMunicipio}.png`);
                isPng = true;
                
                try {
                    await fs.access(logoPath);
                } catch {
                    return;
                }
            }

            const imageBuffer = await fs.readFile(logoPath);
            const logoImage = isPng 
                ? await pdfDoc.embedPng(imageBuffer)
                : await pdfDoc.embedJpg(imageBuffer);

            const pages = pdfDoc.getPages();
            const firstPage = pages[0];

            firstPage.drawImage(logoImage, {
                x: 460,
                y: 804,
                width: 98,
                height: 30
            });
            
            console.log(`✅ Logo adicionado: ${cMunicipio}.${isPng ? 'png' : 'jpg'}`);
        } catch (error) {
            console.error(`⚠️ Erro ao adicionar logo: ${error.message}`);
        }
    }

    formatarData(data) {
        if (!data) return '-';
        const d = new Date(data);
        return d.toLocaleDateString('pt-BR');
    }

    formatarDataHora(data) {
        if (!data) return '-';
        const d = new Date(data);
        return d.toLocaleString('pt-BR', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        });
    }

    formatarCnpj(cnpj) {
        if (!cnpj) return '-';
        const digits = cnpj.replace(/\D/g, '');
        if (digits.length !== 14) return cnpj;
        return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`;
    }

    formatarDocumento(doc) {
        if (!doc) return '-';
        const digits = doc.replace(/\D/g, '');
        if (digits.length === 11) {
            return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
        }
        if (digits.length === 14) {
            return this.formatarCnpj(doc);
        }
        return doc;
    }

    formatarCep(cep) {
        if (!cep) return '-';
        const digits = cep.replace(/\D/g, '');
        if (digits.length !== 8) return cep;
        return `${digits.slice(0, 5)}-${digits.slice(5)}`;
    }

    formatarMoeda(valor, prefixoVazio = '-') {
        if (valor === undefined || valor === null || valor === 0) return prefixoVazio;
        return Number(valor).toLocaleString('pt-BR', {
            style: 'currency',
            currency: 'BRL'
        });
    }

    async concatenarPdfs(...pdfs) {
        try {
            const mergedPdf = await PDFDocument.create();
            for (const pdfBuffer of pdfs) {
                const pdf = await PDFDocument.load(pdfBuffer);
                const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
                copiedPages.forEach((page) => {
                    mergedPdf.addPage(page);
                });
            }
            const mergedPdfBytes = await mergedPdf.save();
            return Buffer.from(mergedPdfBytes);
        } catch (error) {
            throw new Error(`Erro ao concatenar PDFs: ${error.message}`);
        }
    }
}

module.exports = new DanfseService();