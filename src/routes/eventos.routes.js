/**
 * ============================================
 * ROTAS DE EVENTOS DA NFS-E (PADRÃO NACIONAL)
 * ============================================
 * 
 * Implementa os endpoints REST para consulta e registro
 * de eventos de NFS-e conforme padrão nacional ADN.
 * 
 * Endpoints:
 * - GET  /api/nfse/:chaveAcesso/eventos                      → Lista todos eventos
 * - GET  /api/nfse/:chaveAcesso/eventos/:tipoEvento          → Eventos por tipo
 * - GET  /api/nfse/:chaveAcesso/eventos/:tipoEvento/:numSeq  → Evento específico
 * - POST /api/nfse/:chaveAcesso/eventos                      → Registra novo evento
 */

const express = require('express');
const router = express.Router();
const { autenticarAPIKey } = require('../middlewares/auth');
const { query } = require('../config/database');

// ============================================
// MIDDLEWARE: Aplicar autenticação em todas rotas
// ============================================
router.use(autenticarAPIKey);

// ============================================
// TIPOS DE EVENTOS (Padrão Nacional)
// ============================================
const TIPOS_EVENTO = {
    '401100': 'Cancelamento de NFS-e',
    '401110': 'Manifestação do Tomador',
    '401120': 'Registro de Substituição',
    '401130': 'Registro de Intermediário',
    '401140': 'Prorrogação de Prazo',
    '401150': 'Pedido de Análise',
    '401160': 'Confirmação de Emissão'
};

// ============================================
// HELPER: Validar chave de acesso
// ============================================
function validarChaveAcesso(chaveAcesso) {
    // Chave de acesso NFS-e Nacional tem 50 caracteres
    if (!chaveAcesso || chaveAcesso.length !== 50) {
        return {
            valido: false,
            erro: 'Chave de acesso inválida (deve ter 50 caracteres)'
        };
    }
    
    // Verifica se contém apenas números
    if (!/^\d+$/.test(chaveAcesso)) {
        return {
            valido: false,
            erro: 'Chave de acesso deve conter apenas números'
        };
    }
    
    return { valido: true };
}

// ============================================
// HELPER: Validar tipo de evento
// ============================================
function validarTipoEvento(tipoEvento) {
    if (!tipoEvento || !TIPOS_EVENTO[tipoEvento]) {
        return {
            valido: false,
            erro: `Tipo de evento inválido. Tipos válidos: ${Object.keys(TIPOS_EVENTO).join(', ')}`
        };
    }
    
    return { valido: true };
}

// ============================================
// 1. CONSULTAR TODOS EVENTOS DA NFS-E
// ============================================
router.get('/:chaveAcesso/eventos', async (req, res, next) => {
    try {
        const { chaveAcesso } = req.params;
        const cnpjEmpresa = req.empresa.cnpj;
        
        console.log('\n' + '='.repeat(70));
        console.log(`📋 CONSULTAR EVENTOS - Empresa: ${req.empresa.razao_social}`);
        console.log(`   Chave: ${chaveAcesso}`);
        console.log('='.repeat(70));
        
        // Valida chave de acesso
        const validacao = validarChaveAcesso(chaveAcesso);
        if (!validacao.valido) {
            return res.status(400).json({
                sucesso: false,
                erro: validacao.erro,
                chaveRecebida: chaveAcesso,
                tamanho: chaveAcesso?.length || 0
            });
        }
        
        // Busca todos eventos da NFS-e
        const sql = `
            SELECT 
                id,
                chave_acesso,
                tipo_evento,
                numero_sequencial,
                data_evento,
                motivo,
                orgao_autor,
                tipo_autor,
                protocolo_autorizacao,
                status,
                xml_evento,
                xml_retorno,
                codigo_retorno,
                mensagem_retorno,
                created_at
            FROM eventos_nfse
            WHERE chave_acesso = ?
            AND cnpj_empresa = ?
            ORDER BY numero_sequencial ASC, created_at DESC
        `;
        
        const eventos = await query(sql, [chaveAcesso, cnpjEmpresa]);
        
        console.log(`✅ Encontrados ${eventos.length} evento(s)`);
        
        // Formata resposta
        const eventosFormatados = eventos.map(evento => ({
            id: evento.id,
            chaveAcesso: evento.chave_acesso,
            tipoEvento: evento.tipo_evento,
            descricaoEvento: TIPOS_EVENTO[evento.tipo_evento] || 'Tipo desconhecido',
            numeroSequencial: evento.numero_sequencial,
            dataEvento: evento.data_evento,
            motivo: evento.motivo,
            orgaoAutor: evento.orgao_autor,
            tipoAutor: evento.tipo_autor,
            protocoloAutorizacao: evento.protocolo_autorizacao,
            status: evento.status,
            codigoRetorno: evento.codigo_retorno,
            mensagemRetorno: evento.mensagem_retorno,
            registradoEm: evento.created_at
        }));
        
        res.json({
            sucesso: true,
            chaveAcesso,
            totalEventos: eventos.length,
            eventos: eventosFormatados
        });
        
    } catch (error) {
        console.error('❌ Erro ao consultar eventos:', error);
        next(error);
    }
});

// ============================================
// 2. CONSULTAR EVENTOS POR TIPO
// ============================================
router.get('/:chaveAcesso/eventos/:tipoEvento', async (req, res, next) => {
    try {
        const { chaveAcesso, tipoEvento } = req.params;
        const cnpjEmpresa = req.empresa.cnpj;
        
        console.log('\n' + '='.repeat(70));
        console.log(`📋 CONSULTAR EVENTOS POR TIPO - Empresa: ${req.empresa.razao_social}`);
        console.log(`   Chave: ${chaveAcesso}`);
        console.log(`   Tipo: ${tipoEvento} (${TIPOS_EVENTO[tipoEvento] || 'Desconhecido'})`);
        console.log('='.repeat(70));
        
        // Validações
        const validacaoChave = validarChaveAcesso(chaveAcesso);
        if (!validacaoChave.valido) {
            return res.status(400).json({
                sucesso: false,
                erro: validacaoChave.erro
            });
        }
        
        const validacaoTipo = validarTipoEvento(tipoEvento);
        if (!validacaoTipo.valido) {
            return res.status(400).json({
                sucesso: false,
                erro: validacaoTipo.erro,
                tiposValidos: TIPOS_EVENTO
            });
        }
        
        // Busca eventos do tipo específico
        const sql = `
            SELECT 
                id,
                chave_acesso,
                tipo_evento,
                numero_sequencial,
                data_evento,
                motivo,
                orgao_autor,
                tipo_autor,
                protocolo_autorizacao,
                status,
                codigo_retorno,
                mensagem_retorno,
                created_at
            FROM eventos_nfse
            WHERE chave_acesso = ?
            AND cnpj_empresa = ?
            AND tipo_evento = ?
            ORDER BY numero_sequencial ASC, created_at DESC
        `;
        
        const eventos = await query(sql, [chaveAcesso, cnpjEmpresa, tipoEvento]);
        
        console.log(`✅ Encontrados ${eventos.length} evento(s) do tipo ${tipoEvento}`);
        
        // Formata resposta
        const eventosFormatados = eventos.map(evento => ({
            id: evento.id,
            chaveAcesso: evento.chave_acesso,
            tipoEvento: evento.tipo_evento,
            descricaoEvento: TIPOS_EVENTO[evento.tipo_evento],
            numeroSequencial: evento.numero_sequencial,
            dataEvento: evento.data_evento,
            motivo: evento.motivo,
            orgaoAutor: evento.orgao_autor,
            tipoAutor: evento.tipo_autor,
            protocoloAutorizacao: evento.protocolo_autorizacao,
            status: evento.status,
            codigoRetorno: evento.codigo_retorno,
            mensagemRetorno: evento.mensagem_retorno,
            registradoEm: evento.created_at
        }));
        
        res.json({
            sucesso: true,
            chaveAcesso,
            tipoEvento,
            descricaoEvento: TIPOS_EVENTO[tipoEvento],
            totalEventos: eventos.length,
            eventos: eventosFormatados
        });
        
    } catch (error) {
        console.error('❌ Erro ao consultar eventos por tipo:', error);
        next(error);
    }
});

// ============================================
// 3. CONSULTAR EVENTO ESPECÍFICO (POR SEQUÊNCIA)
// ============================================
router.get('/:chaveAcesso/eventos/:tipoEvento/:numSeqEvento', async (req, res, next) => {
    try {
        const { chaveAcesso, tipoEvento, numSeqEvento } = req.params;
        const cnpjEmpresa = req.empresa.cnpj;
        
        console.log('\n' + '='.repeat(70));
        console.log(`🔍 CONSULTAR EVENTO ESPECÍFICO - Empresa: ${req.empresa.razao_social}`);
        console.log(`   Chave: ${chaveAcesso}`);
        console.log(`   Tipo: ${tipoEvento}`);
        console.log(`   Sequência: ${numSeqEvento}`);
        console.log('='.repeat(70));
        
        // Validações
        const validacaoChave = validarChaveAcesso(chaveAcesso);
        if (!validacaoChave.valido) {
            return res.status(400).json({
                sucesso: false,
                erro: validacaoChave.erro
            });
        }
        
        const validacaoTipo = validarTipoEvento(tipoEvento);
        if (!validacaoTipo.valido) {
            return res.status(400).json({
                sucesso: false,
                erro: validacaoTipo.erro,
                tiposValidos: TIPOS_EVENTO
            });
        }
        
        // Valida número sequencial
        if (!numSeqEvento || isNaN(numSeqEvento) || numSeqEvento < 1) {
            return res.status(400).json({
                sucesso: false,
                erro: 'Número sequencial inválido (deve ser um número inteiro positivo)'
            });
        }
        
        // Busca evento específico
        const sql = `
            SELECT 
                id,
                chave_acesso,
                tipo_evento,
                numero_sequencial,
                data_evento,
                motivo,
                orgao_autor,
                tipo_autor,
                protocolo_autorizacao,
                status,
                xml_evento,
                xml_retorno,
                codigo_retorno,
                mensagem_retorno,
                created_at,
                updated_at
            FROM eventos_nfse
            WHERE chave_acesso = ?
            AND cnpj_empresa = ?
            AND tipo_evento = ?
            AND numero_sequencial = ?
            LIMIT 1
        `;
        
        const eventos = await query(sql, [chaveAcesso, cnpjEmpresa, tipoEvento, numSeqEvento]);
        
        if (eventos.length === 0) {
            console.log('⚠️ Evento não encontrado');
            return res.status(404).json({
                sucesso: false,
                erro: 'Evento não encontrado',
                detalhes: {
                    chaveAcesso,
                    tipoEvento,
                    numeroSequencial: numSeqEvento
                }
            });
        }
        
        const evento = eventos[0];
        
        console.log(`✅ Evento encontrado: Protocolo ${evento.protocolo_autorizacao || 'N/A'}`);
        
        res.json({
            sucesso: true,
            evento: {
                id: evento.id,
                chaveAcesso: evento.chave_acesso,
                tipoEvento: evento.tipo_evento,
                descricaoEvento: TIPOS_EVENTO[evento.tipo_evento],
                numeroSequencial: evento.numero_sequencial,
                dataEvento: evento.data_evento,
                motivo: evento.motivo,
                orgaoAutor: evento.orgao_autor,
                tipoAutor: evento.tipo_autor,
                protocoloAutorizacao: evento.protocolo_autorizacao,
                status: evento.status,
                xmlEvento: evento.xml_evento,
                xmlRetorno: evento.xml_retorno,
                codigoRetorno: evento.codigo_retorno,
                mensagemRetorno: evento.mensagem_retorno,
                registradoEm: evento.created_at,
                atualizadoEm: evento.updated_at
            }
        });
        
    } catch (error) {
        console.error('❌ Erro ao consultar evento específico:', error);
        next(error);
    }
});

// ============================================
// 4. REGISTRAR NOVO EVENTO
// ============================================
router.post('/:chaveAcesso/eventos', async (req, res, next) => {
    try {
        const { chaveAcesso } = req.params;
        const cnpjEmpresa = req.empresa.cnpj;
        
        console.log('\n' + '='.repeat(70));
        console.log(`📝 REGISTRAR NOVO EVENTO - Empresa: ${req.empresa.razao_social}`);
        console.log(`   Chave: ${chaveAcesso}`);
        console.log('='.repeat(70));
        
        // Valida chave de acesso
        const validacaoChave = validarChaveAcesso(chaveAcesso);
        if (!validacaoChave.valido) {
            return res.status(400).json({
                sucesso: false,
                erro: validacaoChave.erro
            });
        }
        
        // Extrai dados do corpo da requisição
        const {
            tipoEvento,
            numeroSequencial,
            dataEvento,
            motivo,
            orgaoAutor,
            tipoAutor,
            xml
        } = req.body;
        
        // Validações dos campos obrigatórios
        if (!tipoEvento) {
            return res.status(400).json({
                sucesso: false,
                erro: 'Campo "tipoEvento" é obrigatório',
                tiposValidos: TIPOS_EVENTO
            });
        }
        
        const validacaoTipo = validarTipoEvento(tipoEvento);
        if (!validacaoTipo.valido) {
            return res.status(400).json({
                sucesso: false,
                erro: validacaoTipo.erro,
                tiposValidos: TIPOS_EVENTO
            });
        }
        
        if (!numeroSequencial || isNaN(numeroSequencial) || numeroSequencial < 1) {
            return res.status(400).json({
                sucesso: false,
                erro: 'Campo "numeroSequencial" deve ser um número inteiro positivo'
            });
        }
        
        if (!motivo || motivo.trim().length < 15) {
            return res.status(400).json({
                sucesso: false,
                erro: 'Campo "motivo" é obrigatório e deve ter no mínimo 15 caracteres'
            });
        }
        
        if (!xml) {
            return res.status(400).json({
                sucesso: false,
                erro: 'Campo "xml" é obrigatório (XML do evento assinado)'
            });
        }
        
        console.log(`  → Tipo: ${tipoEvento} (${TIPOS_EVENTO[tipoEvento]})`);
        console.log(`  → Sequência: ${numeroSequencial}`);
        console.log(`  → Motivo: ${motivo.substring(0, 50)}...`);
        
        // Verifica se já existe evento com mesma chave + tipo + sequência
        const sqlVerifica = `
            SELECT id FROM eventos_nfse
            WHERE chave_acesso = ?
            AND cnpj_empresa = ?
            AND tipo_evento = ?
            AND numero_sequencial = ?
        `;
        
        const eventoExistente = await query(sqlVerifica, [
            chaveAcesso,
            cnpjEmpresa,
            tipoEvento,
            numeroSequencial
        ]);
        
        if (eventoExistente.length > 0) {
            return res.status(409).json({
                sucesso: false,
                erro: 'Evento já registrado com esta chave, tipo e sequência',
                eventoId: eventoExistente[0].id
            });
        }
        
        // TODO: Aqui você deve integrar com o serviço SEFIN
        // para enviar o evento à Receita Federal
        // Por enquanto, apenas registramos localmente
        
        console.log('⚠️ ATENÇÃO: Integração com SEFIN não implementada neste exemplo');
        console.log('   Este endpoint apenas registra o evento localmente');
        
        // Insere evento no banco
        const sqlInsert = `
            INSERT INTO eventos_nfse (
                chave_acesso,
                cnpj_empresa,
                tipo_evento,
                numero_sequencial,
                data_evento,
                motivo,
                orgao_autor,
                tipo_autor,
                xml_evento,
                status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        
        const resultado = await query(sqlInsert, [
            chaveAcesso,
            cnpjEmpresa,
            tipoEvento,
            numeroSequencial,
            dataEvento || new Date(),
            motivo,
            orgaoAutor || null,
            tipoAutor || null,
            xml,
            'PENDENTE' // Status inicial
        ]);
        
        console.log(`✅ Evento registrado com ID: ${resultado.insertId}`);
        
        res.status(201).json({
            sucesso: true,
            mensagem: 'Evento registrado com sucesso (pendente envio à SEFIN)',
            evento: {
                id: resultado.insertId,
                chaveAcesso,
                tipoEvento,
                descricaoEvento: TIPOS_EVENTO[tipoEvento],
                numeroSequencial,
                motivo,
                status: 'PENDENTE'
            },
            aviso: 'Este evento foi registrado localmente. Integração com SEFIN deve ser implementada.'
        });
        
    } catch (error) {
        console.error('❌ Erro ao registrar evento:', error);
        next(error);
    }
});

// ============================================
// 5. ENDPOINT DE DOCUMENTAÇÃO
// ============================================
router.get('/eventos/docs', (req, res) => {
    res.json({
        titulo: 'API de Eventos NFS-e (Padrão Nacional)',
        versao: '1.0.0',
        autenticacao: 'API Key via header X-API-Key',
        
        endpoints: {
            listarTodos: {
                metodo: 'GET',
                rota: '/api/nfse/:chaveAcesso/eventos',
                descricao: 'Lista todos os eventos de uma NFS-e',
                exemplo: '/api/nfse/12345678901234567890123456789012345678901234567890/eventos'
            },
            
            listarPorTipo: {
                metodo: 'GET',
                rota: '/api/nfse/:chaveAcesso/eventos/:tipoEvento',
                descricao: 'Lista eventos de um tipo específico',
                exemplo: '/api/nfse/12345678901234567890123456789012345678901234567890/eventos/401100'
            },
            
            buscarEspecifico: {
                metodo: 'GET',
                rota: '/api/nfse/:chaveAcesso/eventos/:tipoEvento/:numSeqEvento',
                descricao: 'Busca um evento específico por tipo e sequência',
                exemplo: '/api/nfse/12345678901234567890123456789012345678901234567890/eventos/401100/1'
            },
            
            registrarNovo: {
                metodo: 'POST',
                rota: '/api/nfse/:chaveAcesso/eventos',
                descricao: 'Registra um novo evento para a NFS-e',
                exemplo: '/api/nfse/12345678901234567890123456789012345678901234567890/eventos',
                body: {
                    tipoEvento: '401100',
                    numeroSequencial: 1,
                    dataEvento: '2025-01-27T10:30:00-03:00',
                    motivo: 'Erro na emissão da nota fiscal',
                    orgaoAutor: '53',
                    tipoAutor: '1',
                    xml: '<pedRegEvento>...</pedRegEvento>'
                }
            }
        },
        
        tiposEvento: TIPOS_EVENTO,
        
        exemploCURL: {
            consultar: `curl -X GET \\
  -H "X-API-Key: sua-api-key" \\
  "http://localhost:3000/api/nfse/12345678901234567890123456789012345678901234567890/eventos"`,
            
            registrar: `curl -X POST \\
  -H "X-API-Key: sua-api-key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "tipoEvento": "401100",
    "numeroSequencial": 1,
    "dataEvento": "2025-01-27T10:30:00-03:00",
    "motivo": "Erro na emissão da nota fiscal",
    "orgaoAutor": "53",
    "tipoAutor": "1",
    "xml": "<pedRegEvento>...</pedRegEvento>"
  }' \\
  "http://localhost:3000/api/nfse/12345678901234567890123456789012345678901234567890/eventos"`
        }
    });
});

module.exports = router;