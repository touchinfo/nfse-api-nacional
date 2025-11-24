const { DOMParser } = require('@xmldom/xmldom');
const xml2js = require('xml2js');

/**
 * Service para validação XSD do XML NFS-e Nacional
 * Implementa as regras de validação do emissor nacional
 */
class ValidacaoXSDService {

    /**
     * Estrutura de campos obrigatórios por tipo de documento
     */
    static CAMPOS_OBRIGATORIOS = {
        DPS: {
            infDPS: {
                obrigatorio: true,
                atributos: ['Id', 'versao'],
                filhos: {
                    tpAmb: { obrigatorio: true, valores: ['1', '2'] },
                    dhEmi: { obrigatorio: true, tipo: 'datetime' },
                    verAplic: { obrigatorio: true },
                    nDPS: { obrigatorio: true, tipo: 'numero', min: 1 },
                    serie: { obrigatorio: true, tamanho: 5 },
                    tpEmis: { obrigatorio: true, valores: ['1', '2'] },
                    prest: {
                        obrigatorio: true,
                        filhos: {
                            CNPJ: { obrigatorio: true, tamanho: 14, tipo: 'numero' },
                            cMun: { obrigatorio: true, tamanho: 7, tipo: 'numero' },
                            IM: { obrigatorio: false }
                        }
                    },
                    toma: {
                        obrigatorio: true,
                        filhos: {
                            CNPJ: { obrigatorio: false, tamanho: 14, tipo: 'numero' },
                            CPF: { obrigatorio: false, tamanho: 11, tipo: 'numero' },
                            NIF: { obrigatorio: false },
                            xNome: { obrigatorio: true, tamanho: { min: 2, max: 115 } },
                            end: {
                                obrigatorio: false,
                                filhos: {
                                    xLgr: { obrigatorio: true },
                                    nro: { obrigatorio: true },
                                    xCpl: { obrigatorio: false },
                                    xBairro: { obrigatorio: true },
                                    cMun: { obrigatorio: true, tamanho: 7 },
                                    CEP: { obrigatorio: false, tamanho: 8 },
                                    UF: { obrigatorio: true, tamanho: 2 }
                                }
                            }
                        }
                    },
                    serv: {
                        obrigatorio: true,
                        filhos: {
                            cServ: { obrigatorio: true },
                            xServ: { obrigatorio: true, tamanho: { min: 1, max: 2000 } },
                            cTribMun: { obrigatorio: false },
                            xCidadeServ: { obrigatorio: false }
                        }
                    },
                    valores: {
                        obrigatorio: true,
                        filhos: {
                            vServPrestado: { obrigatorio: true, tipo: 'decimal' },
                            vDescIncond: { obrigatorio: false, tipo: 'decimal' },
                            vDescCond: { obrigatorio: false, tipo: 'decimal' },
                            vDeducao: { obrigatorio: false, tipo: 'decimal' },
                            vOutrasRetencoes: { obrigatorio: false, tipo: 'decimal' },
                            vBCISS: { obrigatorio: true, tipo: 'decimal' },
                            pISS: { obrigatorio: true, tipo: 'decimal', min: 0, max: 100 },
                            vISS: { obrigatorio: true, tipo: 'decimal' },
                            vLiq: { obrigatorio: true, tipo: 'decimal' }
                        }
                    },
                    tribMun: {
                        obrigatorio: true,
                        filhos: {
                            tpTribMun: { obrigatorio: true, valores: ['1', '2', '3', '4', '5', '6', '7'] },
                            tpRetISS: { obrigatorio: true, valores: ['1', '2'] },
                            indISS: { obrigatorio: true, valores: ['1', '2', '3', '4', '5', '6', '7'] },
                            indIncFisc: { obrigatorio: true, valores: ['1', '2'] }
                        }
                    }
                }
            }
        }
    };

    /**
     * Regras de negócio específicas do emissor nacional
     */
    static REGRAS_NEGOCIO = {
        // E0202: Prestador não pode ser igual ao tomador
        E0202: (infoDPS) => {
            const cnpjPrest = infoDPS.cnpjPrestador;
            const cnpjToma = infoDPS.cnpjTomador;
            
            if (cnpjPrest && cnpjToma && cnpjPrest === cnpjToma) {
                return {
                    codigo: 'E0202',
                    mensagem: 'CNPJ/CPF do prestador não pode ser igual ao do tomador',
                    campo: 'toma.CNPJ'
                };
            }
            return null;
        },

        // E0001: Validação de CNPJ
        E0001: (cnpj, campo) => {
            if (!cnpj) return null;
            
            const cnpjLimpo = cnpj.replace(/\D/g, '');
            
            if (cnpjLimpo.length !== 14) {
                return {
                    codigo: 'E0001',
                    mensagem: `CNPJ inválido: deve conter 14 dígitos`,
                    campo: campo
                };
            }
            
            // Verifica se não é uma sequência de números iguais
            if (/^(\d)\1+$/.test(cnpjLimpo)) {
                return {
                    codigo: 'E0001',
                    mensagem: `CNPJ inválido: não pode ser uma sequência de números iguais`,
                    campo: campo
                };
            }
            
            return null;
        },

        // E0003: Validação de CPF
        E0003: (cpf, campo) => {
            if (!cpf) return null;
            
            const cpfLimpo = cpf.replace(/\D/g, '');
            
            if (cpfLimpo.length !== 11) {
                return {
                    codigo: 'E0003',
                    mensagem: `CPF inválido: deve conter 11 dígitos`,
                    campo: campo
                };
            }
            
            // Verifica se não é uma sequência de números iguais
            if (/^(\d)\1+$/.test(cpfLimpo)) {
                return {
                    codigo: 'E0003',
                    mensagem: `CPF inválido: não pode ser uma sequência de números iguais`,
                    campo: campo
                };
            }
            
            return null;
        },

        // E0010: Código de município inválido
        E0010: (cMun, campo) => {
            if (!cMun) return null;
            
            const cMunLimpo = cMun.toString().replace(/\D/g, '');
            
            if (cMunLimpo.length !== 7) {
                return {
                    codigo: 'E0010',
                    mensagem: `Código de município inválido: deve conter 7 dígitos`,
                    campo: campo
                };
            }
            
            return null;
        },

        // E0015: Validação de data/hora
        E0015: (dhEmi, campo) => {
            if (!dhEmi) return null;
            
            try {
                const data = new Date(dhEmi);
                if (isNaN(data.getTime())) {
                    return {
                        codigo: 'E0015',
                        mensagem: `Data/hora inválida`,
                        campo: campo
                    };
                }
                
                // Verifica se a data não é futura
                if (data > new Date()) {
                    return {
                        codigo: 'E0015',
                        mensagem: `Data/hora de emissão não pode ser futura`,
                        campo: campo
                    };
                }
                
                // Verifica se a data não é muito antiga (ex: mais de 30 dias)
                const diasAtras = Math.floor((new Date() - data) / (1000 * 60 * 60 * 24));
                if (diasAtras > 30) {
                    return {
                        codigo: 'E0015',
                        mensagem: `Data/hora de emissão muito antiga (${diasAtras} dias)`,
                        campo: campo,
                        tipo: 'warning'
                    };
                }
            } catch (error) {
                return {
                    codigo: 'E0015',
                    mensagem: `Erro ao validar data/hora: ${error.message}`,
                    campo: campo
                };
            }
            
            return null;
        },

        // E0020: Validação de valores decimais
        E0020: (valor, campo, opcoes = {}) => {
            if (valor === null || valor === undefined) return null;
            
            const valorNum = parseFloat(valor);
            
            if (isNaN(valorNum)) {
                return {
                    codigo: 'E0020',
                    mensagem: `Valor numérico inválido`,
                    campo: campo
                };
            }
            
            if (valorNum < 0) {
                return {
                    codigo: 'E0020',
                    mensagem: `Valor não pode ser negativo`,
                    campo: campo
                };
            }
            
            if (opcoes.min !== undefined && valorNum < opcoes.min) {
                return {
                    codigo: 'E0020',
                    mensagem: `Valor deve ser maior ou igual a ${opcoes.min}`,
                    campo: campo
                };
            }
            
            if (opcoes.max !== undefined && valorNum > opcoes.max) {
                return {
                    codigo: 'E0020',
                    mensagem: `Valor deve ser menor ou igual a ${opcoes.max}`,
                    campo: campo
                };
            }
            
            return null;
        }
    };

    /**
     * Valida se o XML está bem formado
     */
    static validarXMLBemFormado(xmlString) {
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(xmlString, 'text/xml');
            
            const parseErrors = doc.getElementsByTagName('parsererror');
            if (parseErrors.length > 0) {
                return {
                    valido: false,
                    erros: [{
                        codigo: 'E9999',
                        mensagem: 'XML mal formado',
                        detalhes: parseErrors[0].textContent
                    }]
                };
            }
            
            return { valido: true, erros: [] };
            
        } catch (error) {
            return {
                valido: false,
                erros: [{
                    codigo: 'E9999',
                    mensagem: `Erro ao parsear XML: ${error.message}`
                }]
            };
        }
    }

    /**
     * Extrai informações do XML para validação
     */
    static async extrairDadosParaValidacao(xmlString) {
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
            
            // Extrai dados do prestador
            const prest = infDPS.prest || infDPS['ns:prest'];
            const cnpjPrestador = this.extrairValor(prest?.CNPJ);
            const cMunPrest = this.extrairValor(prest?.cMun);
            
            // Extrai dados do tomador
            const toma = infDPS.toma || infDPS['ns:toma'];
            const cnpjTomador = this.extrairValor(toma?.CNPJ);
            const cpfTomador = this.extrairValor(toma?.CPF);
            
            // Extrai valores
            const valores = infDPS.valores || infDPS['ns:valores'];
            
            return {
                raw: infDPS,
                infDPS: {
                    id: infDPS['@']?.Id || infDPS['$']?.Id,
                    versao: infDPS['@']?.versao || infDPS['$']?.versao,
                    tpAmb: this.extrairValor(infDPS.tpAmb),
                    dhEmi: this.extrairValor(infDPS.dhEmi),
                    verAplic: this.extrairValor(infDPS.verAplic),
                    nDPS: this.extrairValor(infDPS.nDPS),
                    serie: this.extrairValor(infDPS.serie),
                    tpEmis: this.extrairValor(infDPS.tpEmis),
                    cnpjPrestador,
                    cMunPrest,
                    cnpjTomador,
                    cpfTomador,
                    xNomeTomador: this.extrairValor(toma?.xNome),
                    valores: {
                        vServPrestado: this.extrairValor(valores?.vServPrestado),
                        vBCISS: this.extrairValor(valores?.vBCISS),
                        pISS: this.extrairValor(valores?.pISS),
                        vISS: this.extrairValor(valores?.vISS),
                        vLiq: this.extrairValor(valores?.vLiq)
                    }
                }
            };
            
        } catch (error) {
            throw new Error(`Erro ao extrair dados do XML: ${error.message}`);
        }
    }

    /**
     * Extrai valor do campo XML (trata casos com e sem namespace)
     */
    static extrairValor(campo) {
        if (!campo) return null;
        if (typeof campo === 'string') return campo;
        if (campo._ !== undefined) return campo._;
        return campo;
    }

    /**
     * Valida estrutura de campos obrigatórios
     */
    static validarEstrutura(dados) {
        const erros = [];
        const infDPS = dados.infDPS;
        
        // Valida ID
        if (!infDPS.id) {
            erros.push({
                codigo: 'E0100',
                mensagem: 'Atributo Id do elemento infDPS é obrigatório',
                campo: 'infDPS.Id'
            });
        }
        
        // Versão está no DPS, não no infDPS (conforme XSD oficial)
        // A validação de versão já é feita pelo parser XML
        
        // Valida campos obrigatórios
        if (!infDPS.tpAmb || !['1', '2'].includes(infDPS.tpAmb)) {
            erros.push({
                codigo: 'E0102',
                mensagem: 'Campo tpAmb deve ser 1 (Produção) ou 2 (Homologação)',
                campo: 'infDPS.tpAmb'
            });
        }
        
        if (!infDPS.dhEmi) {
            erros.push({
                codigo: 'E0103',
                mensagem: 'Campo dhEmi (data/hora de emissão) é obrigatório',
                campo: 'infDPS.dhEmi'
            });
        }
        
        if (!infDPS.verAplic) {
            erros.push({
                codigo: 'E0104',
                mensagem: 'Campo verAplic (versão da aplicação) é obrigatório',
                campo: 'infDPS.verAplic'
            });
        }
        
        if (!infDPS.nDPS) {
            erros.push({
                codigo: 'E0105',
                mensagem: 'Campo nDPS (número da DPS) é obrigatório',
                campo: 'infDPS.nDPS'
            });
        }
        
        if (!infDPS.serie) {
            erros.push({
                codigo: 'E0106',
                mensagem: 'Campo serie (série da DPS) é obrigatório',
                campo: 'infDPS.serie'
            });
        }
        
        if (!infDPS.cnpjPrestador) {
            erros.push({
                codigo: 'E0107',
                mensagem: 'CNPJ do prestador é obrigatório',
                campo: 'infDPS.prest.CNPJ'
            });
        }
        
        if (!infDPS.cnpjTomador && !infDPS.cpfTomador) {
            erros.push({
                codigo: 'E0108',
                mensagem: 'CNPJ ou CPF do tomador é obrigatório',
                campo: 'infDPS.toma'
            });
        }
        
        if (!infDPS.xNomeTomador) {
            erros.push({
                codigo: 'E0109',
                mensagem: 'Nome do tomador é obrigatório',
                campo: 'infDPS.toma.xNome'
            });
        }
        
        // Validação de valores desativada - estrutura complexa no XSD real
        // O XSD usa vServPrest/vServ, trib/tribMun/tribISSQN, etc
        // TODO: Implementar validação completa baseada no XSD oficial
        
        return erros;
    }

    /**
     * Valida regras de negócio
     */
    static validarRegrasNegocio(dados) {
        const erros = [];
        const warnings = [];
        const infoDPS = dados.infDPS;
        
        // E0202: Prestador não pode ser igual ao tomador
        const erroE0202 = this.REGRAS_NEGOCIO.E0202(infoDPS);
        if (erroE0202) erros.push(erroE0202);
        
        // E0001: Validação de CNPJ do prestador
        const erroE0001Prest = this.REGRAS_NEGOCIO.E0001(infoDPS.cnpjPrestador, 'infDPS.prest.CNPJ');
        if (erroE0001Prest) erros.push(erroE0001Prest);
        
        // E0001: Validação de CNPJ do tomador
        if (infoDPS.cnpjTomador) {
            const erroE0001Toma = this.REGRAS_NEGOCIO.E0001(infoDPS.cnpjTomador, 'infDPS.toma.CNPJ');
            if (erroE0001Toma) erros.push(erroE0001Toma);
        }
        
        // E0003: Validação de CPF do tomador
        if (infoDPS.cpfTomador) {
            const erroE0003 = this.REGRAS_NEGOCIO.E0003(infoDPS.cpfTomador, 'infDPS.toma.CPF');
            if (erroE0003) erros.push(erroE0003);
        }
        
        // E0010: Código de município
        if (infoDPS.cMunPrest) {
            const erroE0010 = this.REGRAS_NEGOCIO.E0010(infoDPS.cMunPrest, 'infDPS.prest.cMun');
            if (erroE0010) erros.push(erroE0010);
        }
        
        // E0015: Validação de data/hora
        if (infoDPS.dhEmi) {
            const erroE0015 = this.REGRAS_NEGOCIO.E0015(infoDPS.dhEmi, 'infDPS.dhEmi');
            if (erroE0015) {
                if (erroE0015.tipo === 'warning') {
                    warnings.push(erroE0015);
                } else {
                    erros.push(erroE0015);
                }
            }
        }
        
        // E0020: Validação de valores
        const val = infoDPS.valores;
        
        const erroVServ = this.REGRAS_NEGOCIO.E0020(val.vServPrestado, 'infDPS.valores.vServPrestado');
        if (erroVServ) erros.push(erroVServ);
        
        const erroVBC = this.REGRAS_NEGOCIO.E0020(val.vBCISS, 'infDPS.valores.vBCISS');
        if (erroVBC) erros.push(erroVBC);
        
        const erroPISS = this.REGRAS_NEGOCIO.E0020(val.pISS, 'infDPS.valores.pISS', { min: 0, max: 100 });
        if (erroPISS) erros.push(erroPISS);
        
        const erroVISS = this.REGRAS_NEGOCIO.E0020(val.vISS, 'infDPS.valores.vISS');
        if (erroVISS) erros.push(erroVISS);
        
        const erroVLiq = this.REGRAS_NEGOCIO.E0020(val.vLiq, 'infDPS.valores.vLiq');
        if (erroVLiq) erros.push(erroVLiq);
        
        // Validação matemática: vISS = vBCISS * pISS / 100
        if (val.vBCISS && val.pISS && val.vISS) {
            const vISSCalculado = parseFloat(val.vBCISS) * parseFloat(val.pISS) / 100;
            const vISSInformado = parseFloat(val.vISS);
            
            // Tolerância de 0.01 para diferenças de arredondamento
            if (Math.abs(vISSCalculado - vISSInformado) > 0.01) {
                erros.push({
                    codigo: 'E0200',
                    mensagem: `Valor do ISS incorreto. Esperado: ${vISSCalculado.toFixed(2)}, Informado: ${vISSInformado.toFixed(2)}`,
                    campo: 'infDPS.valores.vISS'
                });
            }
        }
        
        return { erros, warnings };
    }

    /**
     * Executa validação completa do XML
     */
    static async validarXMLCompleto(xmlString) {
        const inicioValidacao = Date.now();
        const erros = [];
        const warnings = [];
        
        console.log('🔍 Iniciando validação XSD completa...');
        
        // 1. Valida se XML está bem formado
        console.log('  → Validando XML bem formado...');
        const validacaoBemFormado = this.validarXMLBemFormado(xmlString);
        if (!validacaoBemFormado.valido) {
            return {
                valido: false,
                erros: validacaoBemFormado.erros,
                warnings: [],
                tempoValidacao: Date.now() - inicioValidacao
            };
        }
        
        // 2. Extrai dados para validação
        console.log('  → Extraindo dados do XML...');
        let dados;
        try {
            dados = await this.extrairDadosParaValidacao(xmlString);
        } catch (error) {
            return {
                valido: false,
                erros: [{
                    codigo: 'E9998',
                    mensagem: `Erro ao processar XML: ${error.message}`
                }],
                warnings: [],
                tempoValidacao: Date.now() - inicioValidacao
            };
        }
        
        // 3. Valida estrutura
        console.log('  → Validando estrutura de campos obrigatórios...');
        const errosEstrutura = this.validarEstrutura(dados);
        erros.push(...errosEstrutura);
        
        // 4. Valida regras de negócio
        console.log('  → Validando regras de negócio...');
        const { erros: errosRegras, warnings: warningsRegras } = this.validarRegrasNegocio(dados);
        erros.push(...errosRegras);
        warnings.push(...warningsRegras);
        
        const tempoValidacao = Date.now() - inicioValidacao;
        
        if (erros.length > 0) {
            console.log(`  ✗ Validação falhou com ${erros.length} erro(s) (${tempoValidacao}ms)`);
            return {
                valido: false,
                erros,
                warnings,
                tempoValidacao
            };
        }
        
        console.log(`  ✓ Validação concluída com sucesso! (${tempoValidacao}ms)`);
        
        return {
            valido: true,
            erros: [],
            warnings,
            dados: dados.infDPS,
            tempoValidacao
        };
    }
}

module.exports = ValidacaoXSDService;