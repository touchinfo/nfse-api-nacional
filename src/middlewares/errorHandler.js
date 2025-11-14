const winston = require('winston');

/**
 * Configuração do Winston Logger
 */
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        }),
        new winston.transports.File({ 
            filename: process.env.LOG_FILE_PATH || './logs/error.log',
            level: 'error' 
        }),
        new winston.transports.File({ 
            filename: process.env.LOG_FILE_PATH || './logs/combined.log' 
        })
    ]
});

/**
 * Middleware de tratamento de erros
 */
function errorHandler(err, req, res, next) {
    // Log do erro
    logger.error({
        message: err.message,
        stack: err.stack,
        url: req.originalUrl,
        method: req.method,
        ip: req.ip,
        empresa: req.empresa?.cnpj || 'não autenticado'
    });
    
    // Erro de validação
    if (err.name === 'ValidationError') {
        return res.status(400).json({
            sucesso: false,
            erro: 'Erro de validação',
            detalhes: err.message
        });
    }
    
    // Erro de certificado
    if (err.message.includes('certificado') || err.message.includes('senha')) {
        return res.status(400).json({
            sucesso: false,
            erro: 'Erro no certificado digital',
            detalhes: err.message
        });
    }
    
    // Erro de XML
    if (err.message.includes('XML')) {
        return res.status(400).json({
            sucesso: false,
            erro: 'Erro no XML enviado',
            detalhes: err.message
        });
    }
    
    // Erro genérico
    res.status(err.status || 500).json({
        sucesso: false,
        erro: process.env.NODE_ENV === 'production' 
            ? 'Erro interno do servidor' 
            : err.message,
        ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
    });
}

/**
 * Middleware para rotas não encontradas
 */
function notFoundHandler(req, res) {
    res.status(404).json({
        sucesso: false,
        erro: 'Rota não encontrada',
        rota: req.originalUrl
    });
}

/**
 * Middleware de logging de requisições
 */
function requestLogger(req, res, next) {
    const start = Date.now();
    
    res.on('finish', () => {
        const duration = Date.now() - start;
        
        logger.info({
            method: req.method,
            url: req.originalUrl,
            status: res.statusCode,
            duration: `${duration}ms`,
            ip: req.ip,
            empresa: req.empresa?.cnpj || 'não autenticado'
        });
    });
    
    next();
}

module.exports = {
    errorHandler,
    notFoundHandler,
    requestLogger,
    logger
};