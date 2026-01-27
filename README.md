# API NFS-e Nacional 🧾

![Node.js](https://img.shields.io/badge/Node.js-18.x-green)
![Express](https://img.shields.io/badge/Express-4.18-blue)
![MySQL](https://img.shields.io/badge/MySQL-8.0-orange)
![License](https://img.shields.io/badge/License-MIT-yellow)

API RESTful completa para emissão, validação e gerenciamento de Notas Fiscais de Serviço Eletrônicas (NFS-e) no padrão Nacional, com assinatura digital através de certificado A1 e integração direta com a SEFIN.

---

## 📋 Índice

- [Características](#-características)
- [Arquitetura](#-arquitetura)
- [Pré-requisitos](#-pré-requisitos)
- [Instalação](#-instalação)
- [Configuração](#-configuração)
- [Estrutura do Banco de Dados](#-estrutura-do-banco-de-dados)
- [Endpoints da API](#-endpoints-da-api)
  - [NFS-e](#1-nfs-e)
  - [Administração](#2-administração)
  - [DANFSE](#3-danfse)
- [Autenticação](#-autenticação)
- [Exemplos de Uso](#-exemplos-de-uso)
- [Variáveis de Ambiente](#-variáveis-de-ambiente)
- [Gerenciamento de Certificados](#-gerenciamento-de-certificados)
- [Estrutura de Pastas](#-estrutura-de-pastas)
- [Logs e Monitoramento](#-logs-e-monitoramento)
- [Segurança](#-segurança)
- [Troubleshooting](#-troubleshooting)
- [Licença](#-licença)

---

## ✨ Características

### Funcionalidades Principais

- ✅ **Emissão de NFS-e** - Processamento completo de XML no padrão nacional
- ✅ **Assinatura Digital** - Suporte a certificados A1 (PFX/P12)
- ✅ **Validação de XML** - Validação estrutural e de regras de negócio antes do envio
- ✅ **Gestão de Certificados** - Upload, validação e renovação de certificados digitais
- ✅ **Geração de DANFSE** - Criação automática de DANFSEs em PDF
- ✅ **Eventos NFS-e** - Cancelamento e substituição de notas
- ✅ **Multi-empresa** - Suporte para múltiplas empresas com isolamento de dados
- ✅ **Ambientes** - Suporte para produção e homologação
- ✅ **Rate Limiting** - Proteção contra abuso
- ✅ **Logging Completo** - Rastreamento de todas as operações

### Características Técnicas

- 🚀 **Alta Performance** - Pool de conexões MySQL e compressão de respostas
- 🔒 **Segurança** - Criptografia de senhas, Helmet.js, CORS configurável
- 📊 **Observabilidade** - Logs estruturados com Winston
- 🧪 **Validação Robusta** - Express-validator para todos os inputs
- 🔄 **Resiliência** - Tratamento de erros abrangente
- 📚 **Documentação** - Endpoint `/api/docs` com exemplos de uso

---

## 🏗️ Arquitetura

```
API NFS-e Nacional
├── Express.js (API REST)
├── MySQL (Banco de Dados)
├── Node-Forge (Assinatura Digital)
├── PDF-lib (Geração de DANFSEs)
└── Axios (Integração SEFIN)
```

### Fluxo de Emissão

```
Cliente → API Key Auth → Validação XML → Assinatura Digital → 
→ Envio SEFIN → Registro BD → Resposta Cliente
```

---

## 📦 Pré-requisitos

- **Node.js** >= 18.0.0
- **MySQL** >= 8.0
- **Certificado Digital A1** (formato PFX/P12)
- **NPM** ou **Yarn**

---

## 🚀 Instalação

### 1. Clone o repositório

```bash
git clone https://github.com/seu-usuario/nfse-api.git
cd nfse-api
```

### 2. Instale as dependências

```bash
npm install
```

### 3. Configure o banco de dados

Execute o script SQL para criar as tabelas:

```bash
mysql -u seu_usuario -p nfse_nacional < database/schema.sql
```

### 4. Configure as variáveis de ambiente

```bash
cp .env.example .env
nano .env
```

### 5. Inicie o servidor

```bash
# Produção
npm start

# Desenvolvimento (com hot-reload)
npm run dev
```

O servidor estará rodando em `http://localhost:3000`

---

## ⚙️ Configuração

### Arquivo `.env`

Crie um arquivo `.env` na raiz do projeto:

```env
# Banco de dados
DB_HOST=localhost
DB_PORT=3306
DB_USER=seu_usuario
DB_PASSWORD=sua_senha
DB_NAME=nfse_nacional

# Chave de criptografia (64 caracteres hexadecimais)
# Gere uma nova: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
ENCRYPTION_KEY=sua_chave_de_64_caracteres_aqui

# Servidor
PORT=3000
NODE_ENV=production

# Senha administrativa para rotas /api/admin
ADMIN_PASSWORD=sua_senha_admin_segura

# CORS (opcional)
CORS_ORIGIN=*

# URL base da API (para documentação)
BASE_URL=http://localhost:3000
```

### Gerando a Chave de Criptografia

A chave de criptografia é usada para proteger senhas de certificados no banco de dados:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copie a saída (64 caracteres) e cole em `ENCRYPTION_KEY` no arquivo `.env`.

---

## 🗄️ Estrutura do Banco de Dados

### Tabela: `empresas`

Armazena dados das empresas cadastradas:

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `id` | INT | ID único (auto-increment) |
| `cnpj` | VARCHAR(14) | CNPJ (apenas números) |
| `razao_social` | VARCHAR(255) | Razão social |
| `inscricao_municipal` | VARCHAR(20) | Inscrição municipal |
| `codigo_municipio` | VARCHAR(7) | Código IBGE do município |
| `certificado_pfx` | BLOB | Certificado digital (binário) |
| `senha_certificado_encrypted` | TEXT | Senha criptografada |
| `certificado_validade` | DATE | Data de validade do certificado |
| `api_key` | VARCHAR(64) | Chave de API (única) |
| `api_key_ativa` | BOOLEAN | Status da API Key |
| `ativa` | BOOLEAN | Empresa ativa? |
| `ultimo_numero_dps` | BIGINT | Último número de DPS usado |
| `tipo_ambiente` | CHAR(1) | 1=Produção, 2=Homologação |

### Tabela: `nfse_transmissoes`

Registra todas as transmissões de NFS-e:

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `id` | INT | ID único (auto-increment) |
| `empresa_id` | INT | Referência à empresa |
| `id_dps` | VARCHAR(50) | ID da DPS (chave de acesso) |
| `numero_dps` | BIGINT | Número da DPS |
| `serie_dps` | VARCHAR(5) | Série da DPS |
| `xml_enviado` | LONGTEXT | XML original enviado |
| `xml_assinado` | LONGTEXT | XML após assinatura |
| `dps_base64` | LONGTEXT | DPS em Base64 (para SEFIN) |
| `status_envio` | VARCHAR(20) | sucesso / erro |
| `codigo_retorno` | VARCHAR(10) | Código de retorno SEFIN |
| `mensagem_retorno` | TEXT | Mensagem da SEFIN |
| `resposta_completa` | LONGTEXT | Resposta completa (JSON) |
| `numero_protocolo` | VARCHAR(50) | Protocolo de recebimento |
| `data_recebimento` | DATETIME | Data/hora de recebimento SEFIN |
| `tempo_processamento_ms` | INT | Tempo de processamento (ms) |

### Script de Criação

```sql
CREATE DATABASE IF NOT EXISTS nfse_nacional 
  CHARACTER SET utf8mb4 
  COLLATE utf8mb4_unicode_ci;

USE nfse_nacional;

CREATE TABLE empresas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cnpj VARCHAR(14) UNIQUE NOT NULL,
    razao_social VARCHAR(255) NOT NULL,
    nome_fantasia VARCHAR(255),
    inscricao_municipal VARCHAR(20),
    codigo_municipio VARCHAR(7) NOT NULL,
    cep VARCHAR(8),
    logradouro VARCHAR(255),
    numero VARCHAR(20),
    complemento VARCHAR(100),
    bairro VARCHAR(100),
    uf CHAR(2),
    
    certificado_pfx MEDIUMBLOB,
    senha_certificado_encrypted TEXT,
    certificado_validade DATE,
    certificado_emissor VARCHAR(255),
    certificado_titular VARCHAR(255),
    
    opcao_simples_nacional CHAR(1) DEFAULT '3',
    regime_apuracao_tributacao CHAR(1) DEFAULT '1',
    regime_especial_tributacao CHAR(1) DEFAULT '0',
    serie_dps VARCHAR(5) DEFAULT '00001',
    ultimo_numero_dps BIGINT DEFAULT 0,
    tipo_ambiente CHAR(1) DEFAULT '2',
    
    api_key VARCHAR(64) UNIQUE NOT NULL,
    api_key_ativa BOOLEAN DEFAULT TRUE,
    ativa BOOLEAN DEFAULT TRUE,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    INDEX idx_cnpj (cnpj),
    INDEX idx_api_key (api_key),
    INDEX idx_ativa (ativa)
) ENGINE=InnoDB;

CREATE TABLE nfse_transmissoes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    empresa_id INT NOT NULL,
    
    id_dps VARCHAR(50) UNIQUE NOT NULL,
    numero_dps BIGINT NOT NULL,
    serie_dps VARCHAR(5),
    
    xml_enviado LONGTEXT,
    xml_assinado LONGTEXT,
    dps_base64 LONGTEXT,
    
    status_envio VARCHAR(20),
    codigo_retorno VARCHAR(10),
    mensagem_retorno TEXT,
    resposta_completa LONGTEXT,
    numero_protocolo VARCHAR(50),
    data_recebimento DATETIME,
    
    ip_origem VARCHAR(45),
    user_agent VARCHAR(500),
    tempo_processamento_ms INT,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON DELETE CASCADE,
    INDEX idx_empresa (empresa_id),
    INDEX idx_id_dps (id_dps),
    INDEX idx_numero_dps (numero_dps),
    INDEX idx_status (status_envio),
    INDEX idx_data_criacao (created_at)
) ENGINE=InnoDB;
```

---

## 🌐 Endpoints da API

### 1. NFS-e

Todos os endpoints requerem autenticação via API Key.

#### 📤 Emitir NFS-e

```http
POST /api/nfse/emitir
```

**Headers:**
```
X-API-Key: sua_api_key_aqui
Content-Type: application/json
```

**Body:**
```json
{
  "xml": "<DPS>...</DPS>",
  "tipoAmbiente": "2"
}
```

**Resposta de Sucesso (200):**
```json
{
  "sucesso": true,
  "mensagem": "NFS-e transmitida com sucesso",
  "dados": {
    "idDPS": "33033022209443542000103000000000003126010759590277",
    "numeroDPS": "31",
    "serieDPS": "00001",
    "numeroProtocolo": "3300000123456789",
    "dataRecebimento": "2026-01-27T10:30:00",
    "codigoRetorno": "100",
    "mensagemRetorno": "Autorizado o uso da NFS-e",
    "tempoProcessamento": 1250
  }
}
```

**Resposta de Erro (400/500):**
```json
{
  "sucesso": false,
  "erro": "Descrição do erro",
  "detalhes": {
    "campo": "valor",
    "erros": ["lista", "de", "erros"]
  }
}
```

---

#### ✅ Validar XML

Valida o XML sem enviar para a SEFIN.

```http
POST /api/nfse/validar
```

**Headers:**
```
X-API-Key: sua_api_key_aqui
Content-Type: application/json
```

**Body:**
```json
{
  "xml": "<DPS>...</DPS>"
}
```

**Resposta:**
```json
{
  "sucesso": true,
  "valido": true,
  "mensagem": "XML válido",
  "dados": {
    "idDPS": "33033022209443542000103000000000003126010759590277",
    "numeroDPS": 31,
    "serieDPS": "00001",
    "cnpjPrestador": "09443542000103",
    "inscricaoMunicipal": "12345678"
  },
  "warnings": [],
  "tempoValidacao": 45
}
```

---

#### 🔍 Consultar Transmissão

Busca uma transmissão pelo ID da DPS.

```http
GET /api/nfse/consultar/:idDPS
```

**Headers:**
```
X-API-Key: sua_api_key_aqui
```

**Exemplo:**
```bash
GET /api/nfse/consultar/33033022209443542000103000000000003126010759590277
```

**Resposta:**
```json
{
  "sucesso": true,
  "transmissao": {
    "id": 42,
    "idDPS": "33033022209443542000103000000000003126010759590277",
    "numeroDPS": 31,
    "serieDPS": "00001",
    "statusEnvio": "sucesso",
    "codigoRetorno": "100",
    "mensagemRetorno": "Autorizado o uso da NFS-e",
    "numeroProtocolo": "3300000123456789",
    "dataRecebimento": "2026-01-27T10:30:00",
    "tempoProcessamento": 1250,
    "criadoEm": "2026-01-27T10:30:00"
  }
}
```

---

#### 📋 Listar Transmissões

Lista transmissões com paginação.

```http
GET /api/nfse/listar?pagina=1&limite=20
```

**Headers:**
```
X-API-Key: sua_api_key_aqui
```

**Query Parameters:**
- `pagina` (opcional): Número da página (padrão: 1)
- `limite` (opcional): Itens por página (padrão: 20, máx: 100)

**Resposta:**
```json
{
  "sucesso": true,
  "paginacao": {
    "paginaAtual": 1,
    "itensPorPagina": 20,
    "totalItens": 150,
    "totalPaginas": 8
  },
  "transmissoes": [
    {
      "id": 42,
      "idDPS": "33033022209443542...",
      "numeroDPS": 31,
      "statusEnvio": "sucesso",
      "codigoRetorno": "100",
      "criadoEm": "2026-01-27T10:30:00"
    }
  ]
}
```

---

#### 📊 Status da Empresa

Retorna informações sobre a empresa autenticada.

```http
GET /api/nfse/status
```

**Headers:**
```
X-API-Key: sua_api_key_aqui
```

**Resposta:**
```json
{
  "sucesso": true,
  "empresa": {
    "cnpj": "09443542000103",
    "razaoSocial": "SERVICOS DE PRATICAGEM NEW PILOTS LTDA",
    "inscricaoMunicipal": "12345678",
    "ultimoNumeroDPS": 31,
    "tipoAmbiente": "2",
    "certificadoValidade": "2026-12-31",
    "diasRestantesCertificado": 338,
    "certificadoValido": true
  },
  "aviso": null
}
```

---

#### 🔒 Upload de Certificado

Permite que a própria empresa atualize seu certificado digital.

```http
POST /api/nfse/certificado
```

**Headers:**
```
X-API-Key: sua_api_key_aqui
Content-Type: multipart/form-data
```

**Form Data:**
- `certificado`: arquivo .pfx ou .p12
- `senha_certificado`: senha do certificado

**Resposta:**
```json
{
  "sucesso": true,
  "mensagem": "Certificado atualizado com sucesso",
  "validade": "2026-12-31",
  "emissor": "AC SERASA RFB v5",
  "titular": "SERVICOS DE PRATICAGEM NEW PILOTS LTDA"
}
```

---

### 2. Administração

Rotas administrativas protegidas por senha (definida em `ADMIN_PASSWORD` no `.env`).

#### 📝 Cadastrar Empresa

```http
POST /api/admin/cadastrar-empresa
```

**Headers:**
```
Content-Type: multipart/form-data
```

**Form Data:**
```
cnpj: 09443542000103
razao_social: SERVICOS DE PRATICAGEM NEW PILOTS LTDA
nome_fantasia: New Pilots
inscricao_municipal: 12345678
codigo_municipio: 3303302
cep: 20000000
logradouro: Rua Principal
numero: 123
bairro: Centro
uf: RJ
certificado: [arquivo .pfx]
senha_certificado: senha123
opcao_simples_nacional: 3
regime_apuracao_tributacao: 1
tipo_ambiente: 2
senha_admin: sua_senha_admin
```

**Resposta:**
```json
{
  "sucesso": true,
  "mensagem": "Empresa cadastrada com sucesso!",
  "empresa": {
    "id": 1,
    "cnpj": "09443542000103",
    "razaoSocial": "SERVICOS DE PRATICAGEM NEW PILOTS LTDA",
    "apiKey": "a1b2c3d4e5f6...",
    "certificadoValidade": "2026-12-31"
  },
  "avisos": []
}
```

---

#### 🔑 Gerar Nova API Key

```http
POST /api/admin/gerar-apikey
```

**Headers:**
```
Content-Type: application/json
```

**Body:**
```json
{
  "cnpj": "09443542000103",
  "senha_admin": "sua_senha_admin"
}
```

**Resposta:**
```json
{
  "sucesso": true,
  "mensagem": "Nova API Key gerada com sucesso",
  "empresa": {
    "cnpj": "09443542000103",
    "razaoSocial": "SERVICOS DE PRATICAGEM NEW PILOTS LTDA"
  },
  "apiKeyAntiga": "a1b2c3...",
  "apiKeyNova": "x9y8z7...",
  "aviso": "⚠️ Guarde esta API Key! A antiga foi invalidada."
}
```

---

#### 📋 Listar Empresas

```http
POST /api/admin/listar-empresas
```

**Headers:**
```
Content-Type: application/json
```

**Body:**
```json
{
  "senha_admin": "sua_senha_admin"
}
```

**Resposta:**
```json
{
  "sucesso": true,
  "total": 3,
  "empresas": [
    {
      "id": 1,
      "cnpj": "09443542000103",
      "razao_social": "SERVICOS DE PRATICAGEM NEW PILOTS LTDA",
      "api_key": "a1b2c3...",
      "api_key_ativa": 1,
      "ativa": 1,
      "certificado_validade": "2026-12-31",
      "tem_certificado": 1,
      "dias_restantes_cert": 338
    }
  ]
}
```

---

#### ✅ Ativar/Desativar Empresa

```http
POST /api/admin/ativar-empresa
```

**Body:**
```json
{
  "cnpj": "09443542000103",
  "ativar": true,
  "senha_admin": "sua_senha_admin"
}
```

---

#### 🔐 Atualizar Certificado (Admin)

```http
POST /api/admin/atualizar-certificado
```

**Form Data:**
```
cnpj: 09443542000103
certificado: [arquivo .pfx]
senha_certificado: senha123
senha_admin: sua_senha_admin
```

---

### 3. DANFSE

Geração de Documento Auxiliar de NFS-e em PDF.

#### 📄 Gerar DANFSE Individual

```http
POST /api/danfse/gerar
```

**Headers:**
```
X-API-Key: sua_api_key_aqui
Content-Type: application/json
```

**Body (JSON):**
```json
{
  "dados": {
    "ChaveAcesso": "33033022209443542000103000000000003126010759590277",
    "NumeroNfse": "31",
    "NumeroDps": "31",
    "SerieDps": "00001",
    "CnpjPrestador": "09443542000103",
    "NomePrestador": "SERVICOS DE PRATICAGEM NEW PILOTS LTDA",
    "DocumentoTomador": "05429268000167",
    "NomeTomador": "ISS MARINE SERVICES LTDA",
    "ValorServico": 118216.00,
    "BaseCalculoIssqn": 118216.00,
    "AliquotaIssqn": 5.00,
    "ValorIssqn": 5910.80,
    "DataEmissao": "2026-01-27",
    "CodigoVerificacao": "ABC123XYZ"
  }
}
```

**Ou Body (XML):**
```json
{
  "xml": "<DPS>...</DPS>"
}
```

**Resposta:**
Retorna o PDF diretamente no response.

---

#### 📄 Gerar DANFSE em Lote

```http
POST /api/danfse/lote
```

**Body:**
```json
{
  "notas": [
    { "dados": { ... } },
    { "xml": "<DPS>...</DPS>" }
  ]
}
```

**Resposta:**
Retorna um PDF único com todos os DANFSEs concatenados.

---

## 🔐 Autenticação

A API utiliza autenticação via **API Key**, que deve ser enviada no header de todas as requisições aos endpoints `/api/nfse` e `/api/danfse`.

### Formato do Header

Você pode usar qualquer um dos formatos abaixo:

```http
X-API-Key: sua_api_key_aqui
```

Ou:

```http
Authorization: Bearer sua_api_key_aqui
```

### Obtendo uma API Key

1. Cadastre uma empresa usando o endpoint `/api/admin/cadastrar-empresa`
2. A API Key será retornada na resposta
3. Guarde a chave em local seguro (ela é única e não pode ser recuperada)

### Regenerando uma API Key

Use o endpoint `/api/admin/gerar-apikey` para gerar uma nova chave. **Atenção:** a chave antiga será invalidada imediatamente.

---

## 💡 Exemplos de Uso

### cURL

#### Emitir NFS-e

```bash
curl -X POST http://localhost:3000/api/nfse/emitir \
  -H "X-API-Key: sua_api_key_aqui" \
  -H "Content-Type: application/json" \
  -d '{
    "xml": "<DPS>...</DPS>",
    "tipoAmbiente": "2"
  }'
```

#### Validar XML

```bash
curl -X POST http://localhost:3000/api/nfse/validar \
  -H "X-API-Key: sua_api_key_aqui" \
  -H "Content-Type: application/json" \
  -d '{"xml": "<DPS>...</DPS>"}'
```

#### Consultar Transmissão

```bash
curl -X GET http://localhost:3000/api/nfse/consultar/33033022209443542000103000000000003126010759590277 \
  -H "X-API-Key: sua_api_key_aqui"
```

#### Listar Transmissões

```bash
curl -X GET "http://localhost:3000/api/nfse/listar?pagina=1&limite=20" \
  -H "X-API-Key: sua_api_key_aqui"
```

### JavaScript (Axios)

```javascript
const axios = require('axios');

const api = axios.create({
  baseURL: 'http://localhost:3000',
  headers: {
    'X-API-Key': 'sua_api_key_aqui',
    'Content-Type': 'application/json'
  }
});

// Emitir NFS-e
async function emitirNFSe(xml) {
  try {
    const response = await api.post('/api/nfse/emitir', {
      xml: xml,
      tipoAmbiente: '2'
    });
    console.log('Sucesso:', response.data);
  } catch (error) {
    console.error('Erro:', error.response.data);
  }
}

// Consultar status
async function consultarStatus() {
  try {
    const response = await api.get('/api/nfse/status');
    console.log('Status:', response.data);
  } catch (error) {
    console.error('Erro:', error.response.data);
  }
}
```

### Python (Requests)

```python
import requests

API_URL = 'http://localhost:3000'
API_KEY = 'sua_api_key_aqui'

headers = {
    'X-API-Key': API_KEY,
    'Content-Type': 'application/json'
}

# Emitir NFS-e
def emitir_nfse(xml):
    response = requests.post(
        f'{API_URL}/api/nfse/emitir',
        headers=headers,
        json={
            'xml': xml,
            'tipoAmbiente': '2'
        }
    )
    return response.json()

# Listar transmissões
def listar_transmissoes(pagina=1, limite=20):
    response = requests.get(
        f'{API_URL}/api/nfse/listar',
        headers=headers,
        params={
            'pagina': pagina,
            'limite': limite
        }
    )
    return response.json()

# Exemplo de uso
if __name__ == '__main__':
    with open('dps.xml', 'r') as f:
        xml = f.read()
    
    resultado = emitir_nfse(xml)
    print(resultado)
```

---

## 🔧 Variáveis de Ambiente

Todas as variáveis de ambiente devem ser definidas no arquivo `.env`:

| Variável | Obrigatória | Descrição | Exemplo |
|----------|-------------|-----------|---------|
| `DB_HOST` | Sim | Host do MySQL | `localhost` |
| `DB_PORT` | Não | Porta do MySQL | `3306` |
| `DB_USER` | Sim | Usuário do MySQL | `root` |
| `DB_PASSWORD` | Sim | Senha do MySQL | `senha123` |
| `DB_NAME` | Sim | Nome do banco | `nfse_nacional` |
| `ENCRYPTION_KEY` | Sim | Chave 64 chars (hex) | `a1b2c3...` |
| `PORT` | Não | Porta da API | `3000` |
| `NODE_ENV` | Não | Ambiente | `production` |
| `ADMIN_PASSWORD` | Sim | Senha admin | `admin123` |
| `CORS_ORIGIN` | Não | Origem CORS | `*` |
| `BASE_URL` | Não | URL base | `http://localhost:3000` |

---

## 📜 Gerenciamento de Certificados

### Formato Aceito

- **.pfx** ou **.p12** (Certificado A1)
- Tamanho máximo: **5 MB**

### Upload de Certificado

#### Pela Própria Empresa

```bash
curl -X POST http://localhost:3000/api/nfse/certificado \
  -H "X-API-Key: sua_api_key_aqui" \
  -F "certificado=@certificado.pfx" \
  -F "senha_certificado=senha123"
```

#### Pelo Administrador

```bash
curl -X POST http://localhost:3000/api/admin/atualizar-certificado \
  -F "cnpj=09443542000103" \
  -F "certificado=@certificado.pfx" \
  -F "senha_certificado=senha123" \
  -F "senha_admin=admin123"
```

### Validação do Certificado

O sistema valida automaticamente:
- ✅ Data de validade
- ✅ Senha correta
- ✅ Formato válido (PFX/P12)
- ✅ Emissor confiável
- ✅ CNPJ correspondente

### Alertas de Vencimento

Quando você consulta o status da empresa (`GET /api/nfse/status`), a API retorna avisos se:
- 📅 Certificado vence em menos de 30 dias
- ❌ Certificado já está vencido

---

## 📁 Estrutura de Pastas

```
nfse-api/
├── src/
│   ├── app.js                    # Aplicação principal
│   ├── config/
│   │   ├── database.js           # Configuração do MySQL
│   │   ├── templates/            # Templates PDF (DANFSEs)
│   │   └── logos-prefeitura/     # Logos das prefeituras
│   ├── middlewares/
│   │   ├── auth.js               # Autenticação API Key
│   │   └── errorHandler.js       # Tratamento de erros
│   ├── routes/
│   │   ├── nfse.routes.js        # Rotas de NFS-e
│   │   ├── admin.routes.js       # Rotas administrativas
│   │   └── danfse.routes.js      # Rotas de DANFSE
│   └── services/
│       ├── xmlService.js         # Processamento de XML
│       ├── sefinService.js       # Integração com SEFIN
│       ├── certificadoService.js # Gestão de certificados
│       ├── validacaoXSDService.js# Validação de XML
│       ├── danfseService.js      # Geração de DANFSE
│       └── xmlEventoService.js   # Eventos (cancelamento/substituição)
├── logs/                         # Logs da aplicação
├── .env                          # Variáveis de ambiente
├── .env.example                  # Exemplo de .env
├── package.json                  # Dependências
└── README.md                     # Este arquivo
```

---

## 📊 Logs e Monitoramento

### Logs Estruturados

A API utiliza **Winston** para logging estruturado. Os logs são salvos em:

```
logs/
├── combined.log      # Todos os logs
├── error.log         # Apenas erros
└── access.log        # Logs de acesso HTTP
```

### Níveis de Log

- `error` - Erros críticos
- `warn` - Avisos
- `info` - Informações gerais
- `http` - Requisições HTTP
- `debug` - Debug (apenas em desenvolvimento)

### Exemplo de Log

```json
{
  "timestamp": "2026-01-27T10:30:00.123Z",
  "level": "info",
  "message": "NFS-e emitida com sucesso",
  "empresaId": 1,
  "idDPS": "33033022209443542000103000000000003126010759590277",
  "tempoProcessamento": 1250
}
```

### Monitoramento de Health

```bash
curl http://localhost:3000/api/health
```

Retorna:
```json
{
  "status": "online",
  "timestamp": "2026-01-27T10:30:00.123Z",
  "database": "conectado",
  "uptime": 3600
}
```

---

## 🔒 Segurança

### Implementações de Segurança

- ✅ **Helmet.js** - Headers de segurança HTTP
- ✅ **Rate Limiting** - Proteção contra brute-force
- ✅ **CORS** - Configurável por domínio
- ✅ **Criptografia** - Senhas de certificados criptografadas (AES-256)
- ✅ **Validação de Input** - Express-validator em todas as rotas
- ✅ **SQL Injection** - Queries parametrizadas
- ✅ **XSS** - Sanitização de XML
- ✅ **HTTPS** - Recomendado em produção (use proxy reverso)

### Rate Limiting

A API possui rate limiting configurado:
- **100 requisições** por 15 minutos por IP
- Retorna `429 Too Many Requests` quando excedido

### Recomendações para Produção

1. **Use HTTPS** - Configure um proxy reverso (nginx, Apache) com certificado SSL
2. **Firewall** - Restrinja acesso ao MySQL
3. **Backup** - Faça backups regulares do banco de dados
4. **Monitore** - Use ferramentas como PM2, New Relic ou Datadog
5. **Atualize** - Mantenha dependências atualizadas
6. **Limite CORS** - Configure domínios específicos em produção

---

## 🐛 Troubleshooting

### Erro: "Não foi possível conectar ao banco de dados"

**Solução:**
1. Verifique se o MySQL está rodando
2. Confirme as credenciais no arquivo `.env`
3. Teste a conexão manualmente:
```bash
mysql -h localhost -u seu_usuario -p nfse_nacional
```

---

### Erro: "API Key inválida ou inativa"

**Solução:**
1. Verifique se a API Key está correta
2. Confirme que a empresa está ativa no banco
3. Regenere a API Key se necessário:
```bash
curl -X POST http://localhost:3000/api/admin/gerar-apikey \
  -H "Content-Type: application/json" \
  -d '{"cnpj": "09443542000103", "senha_admin": "admin123"}'
```

---

### Erro: "Certificado digital inválido ou vencido"

**Solução:**
1. Verifique a data de validade do certificado
2. Confirme que a senha está correta
3. Faça upload de um novo certificado:
```bash
curl -X POST http://localhost:3000/api/nfse/certificado \
  -H "X-API-Key: sua_api_key" \
  -F "certificado=@novo_certificado.pfx" \
  -F "senha_certificado=senha123"
```

---

### Erro: "ENCRYPTION_KEY deve ter 64 caracteres"

**Solução:**
1. Gere uma nova chave:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
2. Copie a saída para `ENCRYPTION_KEY` no `.env`
3. Reinicie a aplicação

---

### Erro: "Erro ao assinar XML"

**Solução:**
1. Verifique se o certificado está válido
2. Confirme que o XML está bem formado
3. Valide o XML antes de enviar:
```bash
curl -X POST http://localhost:3000/api/nfse/validar \
  -H "X-API-Key: sua_api_key" \
  -H "Content-Type: application/json" \
  -d '{"xml": "<DPS>...</DPS>"}'
```

---

### Performance Lenta

**Soluções:**
1. Aumente o pool de conexões MySQL no `src/config/database.js`:
```javascript
connectionLimit: 20  // Padrão é 10
```
2. Use índices no banco de dados (já configurados no schema)
3. Ative compressão (já ativado por padrão)
4. Use um servidor Redis para cache (implementação futura)

---

## 📚 Recursos Adicionais

### Documentação Oficial NFS-e Nacional

- [Manual de Orientação NFS-e Nacional](https://www.gov.br/nfse)
- [Schema XSD Oficial](http://www.sped.fazenda.gov.br/nfse)

### Ferramentas Úteis

- **Postman Collection** - (em breve)
- **Swagger/OpenAPI** - (em breve)
- **Docker Compose** - (em breve)

---

## 🤝 Contribuindo

Contribuições são bem-vindas! Para contribuir:

1. Fork o projeto
2. Crie uma branch para sua feature (`git checkout -b feature/nova-feature`)
3. Commit suas mudanças (`git commit -m 'Adiciona nova feature'`)
4. Push para a branch (`git push origin feature/nova-feature`)
5. Abra um Pull Request

---

## 📄 Licença

Este projeto está licenciado sob a licença MIT. Veja o arquivo [LICENSE](LICENSE) para mais detalhes.

---

## 👨‍💻 Autor

Desenvolvido com ❤️ para facilitar a emissão de NFS-e no Brasil.

---

## 📞 Suporte

Para dúvidas ou problemas:
- 📧 Email: suporte@exemplo.com
- 💬 Issues: [GitHub Issues](https://github.com/seu-usuario/nfse-api/issues)

---

## 🎯 Roadmap

- [ ] Interface web administrativa
- [ ] Dashboard com estatísticas
- [ ] API de consulta de NFS-e emitidas
- [ ] Webhooks para eventos
- [ ] Suporte a múltiplos certificados por empresa
- [ ] Cache com Redis
- [ ] Containerização com Docker
- [ ] CI/CD com GitHub Actions
- [ ] Testes unitários e integração
- [ ] Documentação Swagger/OpenAPI

---

**Versão:** 1.0.0  
**Última atualização:** 27 de janeiro de 2026