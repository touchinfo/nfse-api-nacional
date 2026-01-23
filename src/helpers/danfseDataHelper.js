const xml2js = require('xml2js');

/**
 * Helper para converter dados do XML da NFS-e para formato do DANFSE
 */
class DanfseDataHelper {

    /**
     * Converte XML da NFS-e para dados do DANFSE
     * @param {string} xmlNFSe - XML da NFS-e retornado pela SEFIN
     * @param {Object} dadosEmpresa - Dados da empresa (prestador)
     * @returns {Promise<Object>} Dados formatados para o DANFSE
     */
    static async converterXMLParaDanfse(xmlNFSe, dadosEmpresa) {
        try {
            const parser = new xml2js.Parser({
                explicitArray: false,
                mergeAttrs: true,
                trim: true
            });

            const resultado = await parser.parseStringPromise(xmlNFSe);
            
            // Navega na estrutura do XML
            const nfse = resultado.NFSe || resultado.resNFSe || resultado;
            const infNFSe = nfse.infNFSe || {};
            const dps = infNFSe.DPS || {};
            const infDPS = dps.infDPS || {};
            
            // ✅ EXTRAI CHAVE DE ACESSO DO ATRIBUTO Id
            // Formato: "NFS33033022209443542000103000000000003126010759590277"
            // Remove o prefixo "NFS" se tiver
            let chaveAcesso = infNFSe.Id || infNFSe.chNFSe || infNFSe.chaveAcesso || '';
            if (chaveAcesso.startsWith('NFS')) {
                chaveAcesso = chaveAcesso.substring(3); // Remove "NFS"
            }
            
            // Extrai dados
            const prestador = infDPS.prest || {};
            const tomador = infDPS.toma || {};
            const servico = infDPS.serv || {};
            const valores = infDPS.valores || servico.valores || {};
            const valoresNFSe = infNFSe.valores || {};
            
            // Monta objeto para DANFSE
            return {
                // Identificação
                ChaveAcesso: chaveAcesso,
                NumeroNfse: infNFSe.nNFSe || infNFSe.numero || '',
                Competencia: this.parseData(infNFSe.dCompetencia || infDPS.dCompet || infDPS.dhEmi),
                DataHoraEmissaoNfse: this.parseData(infNFSe.dhProc || infNFSe.dhEmi),
                NumeroDps: infDPS.nDPS || '',
                SerieDps: infDPS.serie || '',
                DataHoraEmissaoDps: this.parseData(infDPS.dhEmi),

                // Prestador
                CnpjPrestador: prestador.CNPJ || dadosEmpresa.cnpj || '',
                InscricaoMunicipalPrestador: prestador.IM || dadosEmpresa.inscricao_municipal || '',
                TelefonePrestador: dadosEmpresa.telefone || '',
                NomePrestador: prestador.xNome || dadosEmpresa.razao_social || '',
                EmailPrestador: dadosEmpresa.email || '',
                EnderecoPrestador: this.formatarEndereco(dadosEmpresa),
                MunicipioPrestador: dadosEmpresa.municipio || '',
                UfPrestador: dadosEmpresa.uf || '',
                CepPrestador: dadosEmpresa.cep || '',
                DescricaoSimplesNacional: dadosEmpresa.optante_simples ? 'Optante pelo Simples Nacional' : 'Não optante',
                DescricaoRegimeApuracao: dadosEmpresa.regime_apuracao || 'Regime Normal',
                cMunicipioPrestador: prestador.cMun || dadosEmpresa.codigo_municipio || '',

                // Tomador
                DocumentoTomador: tomador.CNPJ || tomador.CPF || '',
                InscricaoMunicipalTomador: tomador.IM || '',
                TelefoneTomador: tomador.fone || '',
                NomeTomador: tomador.xNome || '',
                EmailTomador: tomador.email || '',
                EnderecoTomador: this.formatarEnderecoTomador(tomador),
                MunicipioTomador: `${tomador.xMun || ''} - ${tomador.UF || ''}`,
                CepTomador: tomador.CEP || '',

                // Serviço
                CodigoTributacaoNacional: servico.cTribNac || (servico.cServ && servico.cServ.cTribNac) || '',
                CodigoTributacaoMunicipal: servico.cTribMun || (servico.cServ && servico.cServ.cTribMun) || '',
                LocalPrestacao: this.obterLocalPrestacao(servico, infNFSe),
                PaisPrestacao: servico.cPais === '1058' ? 'Brasil' : '',
                DescricaoServico: servico.xDescServ || (servico.cServ && servico.cServ.xDescServ) || servico.xServ || servico.disc || '',

                // Tributação Municipal
                TributacaoIssqn: this.obterTributacaoISSQN(valores),
                PaisResultado: 'Brasil',
                MunicipioIncidencia: `${servico.xMunIncid || infNFSe.xLocIncid || ''} - ${servico.UFIncid || ''}`,
                RegimeEspecialTributacao: this.obterRegimeEspecial(valores),
                TipoImunidade: valores.tpImunidade || '-',
                SuspensaoIssqn: valores.suspISS ? 'Sim' : 'Não',
                NumeroProcessoSuspensao: valores.nProcessoSusp || '-',
                BeneficioMunicipal: valores.benefMun || '-',
                ValorServico: this.parseValor(valoresNFSe.vServ || valores.vServ || valoresNFSe.vBC),
                DescontoIncondicionado: this.parseValor(valores.vDescIncond),
                TotalDeducoes: this.parseValor(valores.vDed),
                CalculoBM: '-',
                BaseCalculoIssqn: this.parseValor(valoresNFSe.vBC || valores.vBCISS),
                Aliquota: this.parseValor(valoresNFSe.pAliqAplic || valores.pISS) || 0,
                RetencaoIssqn: valores.tpRetISSQN === '2' || valores.indISS === '2' ? 'Retido' : 'Não Retido',
                IssqnApurado: this.parseValor(valoresNFSe.vISSQN || valores.vISS),

                // Tributação Federal
                ValorIrrf: this.parseValor(valores.vRetIRRF || valores.vIR),
                ValorCp: this.parseValor(valores.vRetCP || valores.vCP || valores.vINSS),
                ValorCsll: this.parseValor(valores.vRetCSLL || valores.vCSLL),
                ValorPis: this.parseValor(valores.vPis),
                ValorCofins: this.parseValor(valores.vCofins),
                RetencaoPisCofins: valores.tpRetPisCofins === '1' || valores.indCPRB ? 'Retido' : 'Não Retido',
                TotalTributosFederais: this.calcularTributosFederais(valores),

                // Valores Totais
                DescontoCondicionado: this.parseValor(valores.vDescCond),
                IssqnRetido: valores.tpRetISSQN === '2' || valores.indISS === '2' ? this.parseValor(valoresNFSe.vISSQN || valores.vISS) : 0,
                PisCofinsRetidos: this.parseValor(valores.vPis) + this.parseValor(valores.vCofins),
                ValorLiquido: this.parseValor(valoresNFSe.vLiq || valores.vLiq),

                // Totais Tributos
                TotalTributacaoFederal: this.calcularTributosFederais(valores),
                TotalTributosEstaduais: 0,
                TotalTributosMunicipais: this.parseValor(valoresNFSe.vISSQN || valores.vISS),

                // Informações Complementares
                InformacoesComplementares: infDPS.infComp || servico.infComp || servico.xDescServ || ''
            };
            
        } catch (error) {
            console.error('❌ Erro ao converter XML para DANFSE:', error);
            throw new Error(`Erro ao processar XML: ${error.message}`);
        }
    }

    /**
     * Converte dados da DPS (antes da emissão) para DANFSE
     * Usado para pré-visualização
     */
    static converterDPSParaDanfse(dadosDPS, dadosEmpresa) {
        const infDPS = dadosDPS.infDPS || dadosDPS;
        const prestador = infDPS.prest || {};
        const tomador = infDPS.toma || {};
        const servico = infDPS.serv || {};
        const valores = servico.valores || {};

        return {
            // Identificação (valores temporários)
            ChaveAcesso: 'CHAVE_TEMPORARIA_AGUARDANDO_SEFIN',
            NumeroNfse: 'AGUARDANDO_EMISSAO',
            Competencia: this.parseData(infDPS.dhEmi),
            DataHoraEmissaoNfse: null,
            NumeroDps: infDPS.nDPS || '',
            SerieDps: infDPS.serie || '',
            DataHoraEmissaoDps: this.parseData(infDPS.dhEmi),

            // Prestador
            CnpjPrestador: prestador.CNPJ || dadosEmpresa.cnpj || '',
            InscricaoMunicipalPrestador: prestador.IM || dadosEmpresa.inscricao_municipal || '',
            TelefonePrestador: dadosEmpresa.telefone || '',
            NomePrestador: prestador.xNome || dadosEmpresa.razao_social || '',
            EmailPrestador: dadosEmpresa.email || '',
            EnderecoPrestador: this.formatarEndereco(dadosEmpresa),
            MunicipioPrestador: dadosEmpresa.municipio || '',
            UfPrestador: dadosEmpresa.uf || '',
            CepPrestador: dadosEmpresa.cep || '',
            DescricaoSimplesNacional: dadosEmpresa.optante_simples ? 'Optante pelo Simples Nacional' : 'Não optante',
            DescricaoRegimeApuracao: dadosEmpresa.regime_apuracao || 'Regime Normal',
            cMunicipioPrestador: prestador.cMun || dadosEmpresa.codigo_municipio || '',

            // ... resto dos campos igual ao método anterior
            DocumentoTomador: tomador.CNPJ || tomador.CPF || '',
            InscricaoMunicipalTomador: tomador.IM || '',
            TelefoneTomador: tomador.fone || '',
            NomeTomador: tomador.xNome || '',
            EmailTomador: tomador.email || '',
            EnderecoTomador: this.formatarEnderecoTomador(tomador),
            MunicipioTomador: `${tomador.xMun || ''} - ${tomador.UF || ''}`,
            CepTomador: tomador.CEP || '',

            CodigoTributacaoNacional: servico.cTribNac || '',
            CodigoTributacaoMunicipal: servico.cTribMun || '',
            LocalPrestacao: this.obterLocalPrestacao(servico),
            PaisPrestacao: servico.cPais === '1058' ? 'Brasil' : '',
            DescricaoServico: servico.xServ || servico.disc || '',

            TributacaoIssqn: this.obterTributacaoISSQN(valores),
            PaisResultado: 'Brasil',
            MunicipioIncidencia: `${servico.xMunIncid || ''} - ${servico.UFIncid || ''}`,
            RegimeEspecialTributacao: this.obterRegimeEspecial(valores),
            TipoImunidade: valores.tpImunidade || '-',
            SuspensaoIssqn: valores.suspISS ? 'Sim' : 'Não',
            NumeroProcessoSuspensao: valores.nProcessoSusp || '-',
            BeneficioMunicipal: valores.benefMun || '-',
            ValorServico: this.parseValor(valores.vServPrest || valores.vServ),
            DescontoIncondicionado: this.parseValor(valores.vDescIncond),
            TotalDeducoes: this.parseValor(valores.vDed),
            CalculoBM: '-',
            BaseCalculoIssqn: this.parseValor(valores.vBCISS),
            Aliquota: this.parseValor(valores.pISS) || 0,
            RetencaoIssqn: valores.indISS === '2' ? 'Retido' : 'Não Retido',
            IssqnApurado: this.parseValor(valores.vISS),

            ValorIrrf: this.parseValor(valores.vIR),
            ValorCp: this.parseValor(valores.vCP || valores.vINSS),
            ValorCsll: this.parseValor(valores.vCSLL),
            ValorPis: this.parseValor(valores.vPIS),
            ValorCofins: this.parseValor(valores.vCOFINS),
            RetencaoPisCofins: valores.indCPRB ? 'Retido' : 'Não Retido',
            TotalTributosFederais: this.calcularTributosFederais(valores),

            DescontoCondicionado: this.parseValor(valores.vDescCond),
            IssqnRetido: valores.indISS === '2' ? this.parseValor(valores.vISS) : 0,
            PisCofinsRetidos: this.parseValor(valores.vPIS) + this.parseValor(valores.vCOFINS),
            ValorLiquido: this.parseValor(valores.vLiq),

            TotalTributacaoFederal: this.calcularTributosFederais(valores),
            TotalTributosEstaduais: 0,
            TotalTributosMunicipais: this.parseValor(valores.vISS),

            InformacoesComplementares: infDPS.infComp || servico.infComp || ''
        };
    }

    // ===== MÉTODOS AUXILIARES =====

    static parseData(dataString) {
        if (!dataString) return null;
        try {
            return new Date(dataString);
        } catch {
            return null;
        }
    }

    static parseValor(valor) {
        if (!valor) return 0;
        return parseFloat(valor) || 0;
    }

    static formatarEndereco(dados) {
        if (!dados) return '-';
        const partes = [
            dados.logradouro,
            dados.numero,
            dados.complemento,
            dados.bairro
        ].filter(Boolean);
        return partes.join(', ') || '-';
    }

    static formatarEnderecoTomador(tomador) {
        if (!tomador) return '-';
        const partes = [
            tomador.xLgr,
            tomador.nro,
            tomador.xCpl,
            tomador.xBairro
        ].filter(Boolean);
        return partes.join(', ') || '-';
    }

    static obterLocalPrestacao(servico, infNFSe) {
        if (!servico && !infNFSe) return '-';
        
        // Tenta pegar de infNFSe primeiro (xLocPrestacao)
        if (infNFSe && infNFSe.xLocPrestacao) {
            return infNFSe.xLocPrestacao;
        }
        
        // Senão, monta do serviço
        const locPrest = servico.locPrest || {};
        const municipio = locPrest.xMunPrestacao || servico.xMunIncid || '';
        const uf = locPrest.UFPrestacao || servico.UFIncid || '';
        
        if (municipio && uf) {
            return `${municipio} - ${uf}`;
        }
        
        return municipio || uf || '-';
    }

    static obterTributacaoISSQN(valores) {
        if (!valores) return 'Operação Tributável';
        if (valores.exigISS === '1') return 'Exigível';
        if (valores.exigISS === '2') return 'Não incidência';
        if (valores.exigISS === '3') return 'Isenção';
        if (valores.exigISS === '4') return 'Exportação';
        if (valores.exigISS === '5') return 'Imunidade';
        return 'Operação Tributável';
    }

    static obterRegimeEspecial(valores) {
        if (!valores || !valores.regEspTrib) return 'Nenhum';
        const regimes = {
            '1': 'Microempresa Municipal',
            '2': 'Estimativa',
            '3': 'Sociedade de Profissionais',
            '4': 'Cooperativa',
            '5': 'Microempresário Individual (MEI)',
            '6': 'Microempresa ou Empresa de Pequeno Porte (ME/EPP)'
        };
        return regimes[valores.regEspTrib] || 'Nenhum';
    }

    static calcularTributosFederais(valores) {
        return (
            this.parseValor(valores.vRetIRRF || valores.vIR) +
            this.parseValor(valores.vRetCP || valores.vCP || valores.vINSS) +
            this.parseValor(valores.vRetCSLL || valores.vCSLL) +
            this.parseValor(valores.vPis || valores.vPIS) +
            this.parseValor(valores.vCofins || valores.vCOFINS)
        );
    }
}

module.exports = DanfseDataHelper;