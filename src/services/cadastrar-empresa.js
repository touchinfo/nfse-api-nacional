require('dotenv').config();
const fs = require('fs');
const readline = require('readline');
const crypto = require('crypto');
const CryptoJS = require('crypto-js');
const forge = require('node-forge');
const { query, testarConexao, closePool } = require('../config/database');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function pergunta(texto) {
    return new Promise(resolve => {
        rl.question(texto, resolve);
    });
}

/**
 * Criptografa senha usando AES-256
 */
function encryptSenha(senha) {
    const key = process.env.ENCRYPTION_KEY;
    return CryptoJS.AES.encrypt(senha, key).toString();
}

/**
 * Valida certificado e extrai informações
 */
function validarCertificado(caminhoArquivo, senha) {
    try {
        const certificadoBuffer = fs.readFileSync(caminhoArquivo);
        const p12Der = certificadoBuffer.toString('binary');
        const p12Asn1 = forge.asn1.fromDer(p12Der);
        const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, senha);
        
        const bags = p12.getBags({ bagType: forge.pki.oids.certBag });
        const certBag = bags[forge.pki.oids.certBag][0];
        const certificate = certBag.cert;
        
        const subject = certificate.subject.attributes.reduce((acc, attr) => {
            acc[attr.shortName] = attr.value;
            return acc;
        }, {});
        
        const issuer = certificate.issuer.attributes.reduce((acc, attr) => {
            acc[attr.shortName] = attr.value;
            return acc;
        }, {});
        
        let cnpj = null;
        if (subject.serialNumber) {
            const numeros = subject.serialNumber.replace(/\D/g, '');
            if (numeros.length >= 14) {
                cnpj = numeros.substring(0, 14);
            }
        }
        
        return {
            valido: true,
            titular: subject.CN || 'N/A',
            cnpj: cnpj,
            emissor: issuer.CN || 'N/A',
            validadeFim: certificate.validity.notAfter,
            certificadoBuffer
        };
        
    } catch (error) {
        return {
            valido: false,
            erro: error.message
        };
    }
}

async function cadastrarEmpresa() {
    try {
        console.log('\n' + '='.repeat(70));
        console.log('📝 CADASTRO DE EMPRESA - API NFS-e Nacional');
        console.log('='.repeat(70) + '\n');
        
        // Testa conexão
        const dbOk = await testarConexao();
        if (!dbOk) {
            console.error('❌ Erro ao conectar no banco de dados');
            process.exit(1);
        }
        
        // Dados da empresa
        console.log('🏢 Dados da Empresa:\n');
        
        const cnpj = await pergunta('CNPJ (apenas números): ');
        if (cnpj.length !== 14) {
            throw new Error('CNPJ deve ter 14 dígitos');
        }
        
        const razaoSocial = await pergunta('Razão Social: ');
        const nomeFantasia = await pergunta('Nome Fantasia (opcional): ');
        const inscricaoMunicipal = await pergunta('Inscrição Municipal (opcional): ');
        
        console.log('\n📍 Endereço:\n');
        
        const codigoMunicipio = await pergunta('Código do Município (IBGE - 7 dígitos): ');
        const cep = await pergunta('CEP (apenas números): ');
        const logradouro = await pergunta('Logradouro: ');
        const numero = await pergunta('Número: ');
        const complemento = await pergunta('Complemento (opcional): ');
        const bairro = await pergunta('Bairro: ');
        const uf = await pergunta('UF (2 letras): ');
        
        console.log('\n🔐 Certificado Digital:\n');
        
        const caminhoCertificado = await pergunta('Caminho do certificado (.pfx ou .p12): ');
        
        if (!fs.existsSync(caminhoCertificado)) {
            throw new Error('Arquivo de certificado não encontrado');
        }
        
        const senhaCertificado = await pergunta('Senha do certificado: ');
        
        console.log('\n  → Validando certificado...');
        
        const certInfo = validarCertificado(caminhoCertificado, senhaCertificado);
        
        if (!certInfo.valido) {
            throw new Error(`Certificado inválido: ${certInfo.erro}`);
        }
        
        console.log('  ✓ Certificado válido!');
        console.log(`    Titular: ${certInfo.titular}`);
        console.log(`    CNPJ: ${certInfo.cnpj}`);
        console.log(`    Emissor: ${certInfo.emissor}`);
        console.log(`    Validade: ${certInfo.validadeFim.toLocaleDateString()}`);
        
        if (certInfo.cnpj && certInfo.cnpj !== cnpj) {
            console.warn(`\n  ⚠️  AVISO: CNPJ do certificado (${certInfo.cnpj}) diferente do informado (${cnpj})`);
            const continuar = await pergunta('  Deseja continuar mesmo assim? (s/n): ');
            if (continuar.toLowerCase() !== 's') {
                console.log('  Cadastro cancelado.');
                process.exit(0);
            }
        }
        
        console.log('\n⚙️  Configurações:\n');
        
        const opcaoSimples = await pergunta('Opção Simples Nacional (1=SIM, 2=NÃO, 3=Não se aplica) [3]: ') || '3';
        const regimeApuracao = await pergunta('Regime de Apuração (1=Mensal, 2=Anual) [1]: ') || '1';
        const regimeEspecial = await pergunta('Regime Especial Tributação [0]: ') || '0';
        const serieDPS = await pergunta('Série DPS [00001]: ') || '00001';
        const tipoAmbiente = await pergunta('Tipo Ambiente (1=Produção, 2=Homologação) [2]: ') || '2';
        
        // Gera API Key única
        const apiKey = crypto.randomBytes(32).toString('hex');
        
        console.log('\n' + '='.repeat(70));
        console.log('📋 RESUMO DO CADASTRO');
        console.log('='.repeat(70));
        console.log(`CNPJ: ${cnpj}`);
        console.log(`Razão Social: ${razaoSocial}`);
        console.log(`Município: ${codigoMunicipio}`);
        console.log(`Ambiente: ${tipoAmbiente === '1' ? 'Produção' : 'Homologação'}`);
        console.log(`API Key: ${apiKey}`);
        console.log('='.repeat(70) + '\n');
        
        const confirmar = await pergunta('Confirma o cadastro? (s/n): ');
        
        if (confirmar.toLowerCase() !== 's') {
            console.log('Cadastro cancelado.');
            process.exit(0);
        }
        
        console.log('\n  → Criptografando senha do certificado...');
        const senhaEncrypted = encryptSenha(senhaCertificado);
        
        console.log('  → Inserindo no banco de dados...');
        
        const sql = `
            INSERT INTO empresas (
                cnpj,
                razao_social,
                nome_fantasia,
                inscricao_municipal,
                codigo_municipio,
                cep,
                logradouro,
                numero,
                complemento,
                bairro,
                uf,
                certificado_pfx,
                senha_certificado_encrypted,
                certificado_validade,
                certificado_emissor,
                certificado_titular,
                opcao_simples_nacional,
                regime_apuracao_tributacao,
                regime_especial_tributacao,
                serie_dps,
                tipo_ambiente,
                api_key
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        
        const params = [
            cnpj,
            razaoSocial,
            nomeFantasia || null,
            inscricaoMunicipal || null,
            codigoMunicipio,
            cep,
            logradouro,
            numero,
            complemento || null,
            bairro,
            uf.toUpperCase(),
            certInfo.certificadoBuffer,
            senhaEncrypted,
            certInfo.validadeFim.toISOString().split('T')[0],
            certInfo.emissor,
            certInfo.titular,
            opcaoSimples,
            regimeApuracao,
            regimeEspecial,
            serieDPS,
            tipoAmbiente,
            apiKey
        ];
        
        await query(sql, params);
        
        console.log('\n' + '='.repeat(70));
        console.log('✅ EMPRESA CADASTRADA COM SUCESSO!');
        console.log('='.repeat(70));
        console.log('\n🔑 IMPORTANTE - Guarde sua API Key:\n');
        console.log(`   ${apiKey}\n`);
        console.log('Use esta API Key no header das requisições:');
        console.log('   X-API-Key: ' + apiKey);
        console.log('\n' + '='.repeat(70) + '\n');
        
    } catch (error) {
        console.error('\n❌ Erro:', error.message);
        console.error(error.stack);
    } finally {
        rl.close();
        await closePool();
    }
}

cadastrarEmpresa();