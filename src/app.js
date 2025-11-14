require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { testarConexao } = require('./config/database');
const { autenticarAPIKey } = require('./middlewares/auth');
const { errorHandler, notFoundHandler, requestLogger } = require('./middlewares/errorHandler');
const nfseRoutes = require('./routes/nfse.routes');
const adminRoutes = require('./routes/admin.routes');

const app = express();

// ============================================
// MIDDLEWARES GLOBAIS
// ============================================

// Segurança
app.use(helmet());

// CORS
app.use(cors({
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'X-API-Key', 'Authorization']
}));

// Compressão de respostas
app.use(compression());

// Parser de JSON (limite de 10MB para XMLs grandes)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Logging de requisições
app.use(requestLogger);

// Rate limiting
const limiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutos
    max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
    message: {
        sucesso: false,
        erro: 'Muitas requisições. Tente novamente mais tarde.'
    },
    standardHeaders: true,
    legacyHeaders: false
});

app.use('/api/', limiter);

// ============================================
// ROTAS
// ============================================

/**
 * Rota raiz
 */
app.get('/', (req, res) => {
    res.json({
        nome: 'API NFS-e Nacional',
        versao: '1.0.0',
        status: 'online',
        documentacao: '/api/docs',
        ambiente: process.env.NODE_ENV || 'development'
    });
});

/**
 * Health check
 */
app.get('/api/health', async (req, res) => {
    const dbStatus = await testarConexao();
    
    res.json({
        status: 'online',
        timestamp: new Date().toISOString(),
        database: dbStatus ? 'conectado' : 'erro',
        uptime: process.uptime()
    });
});

/**
 * Documentação básica da API
 */
app.get('/api/docs', (req, res) => {
    res.json({
        nome: 'API NFS-e Nacional',
        versao: '1.0.0',
        autenticacao: {
            tipo: 'API Key',
            header: 'X-API-Key ou Authorization: Bearer {sua-api-key}'
        },
        endpoints: {
            emitir: {
                metodo: 'POST',
                rota: '/api/nfse/emitir',
                descricao: 'Emite uma NFS-e processando o XML',
                body: {
                    xml: 'string (XML da DPS)',
                    tipoAmbiente: 'string opcional (1=Produção, 2=Homologação)'
                }
            },
            validar: {
                metodo: 'POST',
                rota: '/api/nfse/validar',
                descricao: 'Valida o XML sem enviar para SEFIN',
                body: {
                    xml: 'string (XML da DPS)'
                }
            },
            consultar: {
                metodo: 'GET',
                rota: '/api/nfse/consultar/:idDPS',
                descricao: 'Consulta uma transmissão pelo ID da DPS'
            },
            listar: {
                metodo: 'GET',
                rota: '/api/nfse/listar',
                descricao: 'Lista transmissões com paginação',
                query: {
                    pagina: 'number (padrão: 1)',
                    limite: 'number (padrão: 20, max: 100)'
                }
            },
            status: {
                metodo: 'GET',
                rota: '/api/nfse/status',
                descricao: 'Status da empresa e última numeração'
            }
        },
        exemplos: {
            curl_emitir: `curl -X POST ${process.env.BASE_URL || 'http://localhost:3000'}/api/nfse/emitir \\
  -H "X-API-Key: sua-api-key-aqui" \\
  -H "Content-Type: application/json" \\
  -d '{"xml": "<DPS>...</DPS>"}'`,
            
            curl_validar: `curl -X POST ${process.env.BASE_URL || 'http://localhost:3000'}/api/nfse/validar \\
  -H "X-API-Key: sua-api-key-aqui" \\
  -H "Content-Type: application/json" \\
  -d '{"xml": "<DPS>...</DPS>"}'`,
            
            curl_consultar: `curl -X GET ${process.env.BASE_URL || 'http://localhost:3000'}/api/nfse/consultar/DPS123... \\
  -H "X-API-Key: sua-api-key-aqui"`,
            
            curl_listar: `curl -X GET "${process.env.BASE_URL || 'http://localhost:3000'}/api/nfse/listar?pagina=1&limite=20" \\
  -H "X-API-Key: sua-api-key-aqui"`,
            
            curl_status: `curl -X GET ${process.env.BASE_URL || 'http://localhost:3000'}/api/nfse/status \\
  -H "X-API-Key: sua-api-key-aqui"`
        }
    });
});

/**
 * Rotas da NFS-e (protegidas por autenticação)
 */
app.use('/api/nfse', autenticarAPIKey, nfseRoutes);

app.use('/api/admin', adminRoutes);

/**
 * Rota não encontrada
 */
app.use(notFoundHandler);

/**
 * Handler de erros
 */
app.use(errorHandler);

// ============================================
// INICIALIZAÇÃO DO SERVIDOR
// ============================================

const PORT = process.env.PORT || 3000;

async function iniciarServidor() {
    try {
        // Testa conexão com banco
        console.log('🔍 Testando conexão com banco de dados...');
        const dbOk = await testarConexao();
        
        if (!dbOk) {
            console.error('❌ Não foi possível conectar ao banco de dados');
            console.error('   Verifique as configurações no arquivo .env');
            process.exit(1);
        }
        
        // Cria diretório de logs se não existir
        const fs = require('fs');
        const logsDir = './logs';
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir);
            console.log('📁 Diretório de logs criado');
        }
        
        // Inicia servidor
        app.listen(PORT, () => {
            console.log('\n' + '='.repeat(80));
            console.log('🚀 API NFS-e NACIONAL - SERVIDOR INICIADO');
            console.log('='.repeat(80));
            console.log(`\n📡 Servidor rodando em: http://localhost:${PORT}`);
            console.log(`📚 Documentação: http://localhost:${PORT}/api/docs`);
            console.log(`💚 Health check: http://localhost:${PORT}/api/health`);
            console.log(`\n🔐 Autenticação: API Key no header X-API-Key`);
            console.log(`🌍 Ambiente: ${process.env.NODE_ENV || 'development'}`);
            console.log(`\n📋 Endpoints disponíveis:`);
            console.log(`   POST   /api/nfse/emitir    - Emite NFS-e`);
            console.log(`   POST   /api/nfse/validar   - Valida XML`);
            console.log(`   GET    /api/nfse/consultar/:id - Consulta transmissão`);
            console.log(`   GET    /api/nfse/listar    - Lista transmissões`);
            console.log(`   GET    /api/nfse/status    - Status da empresa`);
            console.log('\n' + '='.repeat(80));
            console.log('✅ Pronto para receber requisições!\n');
        });
        
    } catch (error) {
        console.error('❌ Erro ao iniciar servidor:', error);
        process.exit(1);
    }
}

// Tratamento de erros não capturados
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    process.exit(1);
});

// Inicia o servidor
iniciarServidor();

module.exports = app;