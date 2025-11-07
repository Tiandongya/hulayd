const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const http = require('http');
const { EventEmitter } = require('events');

// 日志记录器模块
class LoggingService {
  constructor(serviceName = 'CloudProxy') {
    this.serviceName = serviceName;
  }
  
  _formatMessage(level, message) {
    const timestamp = new Date().toISOString();
    return `[${level}] ${timestamp} [${this.serviceName}] - ${message}`;
  }
  
  info(message) {
    console.log(this._formatMessage('INFO', message));
  }
  
  error(message) {
    console.error(this._formatMessage('ERROR', message));
  }
  
  warn(message) {
    console.warn(this._formatMessage('WARN', message));
  }
}

// 消息队列实现
class MessageQueue extends EventEmitter {
  constructor(timeoutMs = 30000) {
    super();
    this.messages = [];
    this.waitingResolvers = [];
    this.defaultTimeout = timeoutMs;
    this.closed = false;
  }
  
  enqueue(message) {
    if (this.closed) return;
    
    if (this.waitingResolvers.length > 0) {
      const resolver = this.waitingResolvers.shift();
      resolver.resolve(message);
    } else {
      this.messages.push(message);
    }
  }
  
  async dequeue(timeoutMs = this.defaultTimeout) {
    if (this.closed) {
      throw new Error('Queue is closed');
    }
    
    return new Promise((resolve, reject) => {
      if (this.messages.length > 0) {
        resolve(this.messages.shift());
        return;
      }
      
      const resolver = { resolve, reject };
      this.waitingResolvers.push(resolver);
      
      const timeoutId = setTimeout(() => {
        const index = this.waitingResolvers.indexOf(resolver);
        if (index !== -1) {
          this.waitingResolvers.splice(index, 1);
          reject(new Error('Queue timeout'));
        }
      }, timeoutMs);
      
      resolver.timeoutId = timeoutId;
    });
  }
  
  close() {
    this.closed = true;
    this.waitingResolvers.forEach(resolver => {
      clearTimeout(resolver.timeoutId);
      resolver.reject(new Error('Queue closed'));
    });
    this.waitingResolvers = [];
    this.messages = [];
  }
}

// WebSocket连接管理器
class ConnectionRegistry extends EventEmitter {
  constructor(logger) {
    super();
    this.logger = logger;
    this.connections = new Set();
    this.messageQueues = new Map();
  }
  
  addConnection(websocket, clientInfo) {
    this.connections.add(websocket);
    this.logger.info(`🌐 新浏览器客户端连接: ${clientInfo.address || '未知地址'}`);
    
    websocket.on('message', (data) => {
      this._handleIncomingMessage(data.toString(), websocket);
    });
    
    websocket.on('close', () => {
      this._removeConnection(websocket);
    });
    
    websocket.on('error', (error) => {
      this.logger.error(`WebSocket连接错误: ${error.message}`);
      this._removeConnection(websocket);
    });
    
    // 发送连接确认消息
    websocket.send(JSON.stringify({
      type: 'connection_established',
      message: '已连接到云端代理服务器',
      timestamp: new Date().toISOString()
    }));
    
    this.emit('connectionAdded', websocket);
  }
  
  _removeConnection(websocket) {
    if (this.connections.has(websocket)) {
      this.connections.delete(websocket);
      this.logger.info('❌ 浏览器客户端连接断开');
      
      // 清理所有相关的消息队列
      this.messageQueues.forEach(queue => queue.close());
      this.messageQueues.clear();
      
      this.emit('connectionRemoved', websocket);
    }
  }
  
  _handleIncomingMessage(messageData, websocket) {
    try {
      const parsedMessage = JSON.parse(messageData);
      const requestId = parsedMessage.request_id;
      
      if (!requestId) {
        this.logger.warn('收到无效消息：缺少request_id');
        return;
      }
      
      const queue = this.messageQueues.get(requestId);
      if (queue) {
        this._routeMessage(parsedMessage, queue);
      } else {
        this.logger.warn(`收到未知请求ID的消息: ${requestId}`);
      }
    } catch (error) {
      this.logger.error('解析WebSocket消息失败:', error.message);
    }
  }
  
  _routeMessage(message, queue) {
    const { event_type } = message;
    
    switch (event_type) {
      case 'response_headers':
      case 'chunk':
      case 'error':
        queue.enqueue(message);
        break;
      case 'stream_close':
        queue.enqueue({ type: 'STREAM_END' });
        break;
      default:
        this.logger.warn(`未知的事件类型: ${event_type}`);
    }
  }
  
  hasActiveConnections() {
    return this.connections.size > 0;
  }
  
  getFirstConnection() {
    return this.connections.values().next().value;
  }
  
  createMessageQueue(requestId) {
    const queue = new MessageQueue();
    this.messageQueues.set(requestId, queue);
    return queue;
  }
  
  removeMessageQueue(requestId) {
    const queue = this.messageQueues.get(requestId);
    if (queue) {
      queue.close();
      this.messageQueues.delete(requestId);
    }
  }
  
  // 广播消息给所有连接
  broadcast(message) {
    const messageStr = typeof message === 'string' ? message : JSON.stringify(message);
    this.connections.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(messageStr);
      }
    });
  }
}

// 请求处理器
class RequestHandler {
  constructor(connectionRegistry, logger) {
    this.connectionRegistry = connectionRegistry;
    this.logger = logger;
  }
  
  async processRequest(req, res) {
    this.logger.info(`处理请求: ${req.method} ${req.path} from ${req.ip}`);
    
    // 设置CORS头
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    // 处理预检请求
    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }
    
    // 健康检查端点
    if (req.path === '/health' || req.path === '/') {
      return res.json({
        status: 'ok',
        service: 'Google AI Studio 云端代理',
        connected_clients: this.connectionRegistry.connections.size,
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development'
      });
    }
    
    // 模型列表端点 (SillyTavern需要)
    if (req.path === '/v1/models') {
      return res.json({
        object: "list",
        data: [
          {
            id: "gemini-pro",
            object: "model",
            created: 1677610602,
            owned_by: "google"
          },
          {
            id: "gemini-2.5-pro", 
            object: "model",
            created: 1717610602,
            owned_by: "google"
          },
          {
            id: "gemini-1.5-pro",
            object: "model", 
            created: 1707610602,
            owned_by: "google"
          }
        ]
      });
    }
    
    // 连接状态检查端点
    if (req.path === '/status') {
      const hasConnections = this.connectionRegistry.hasActiveConnections();
      return res.json({
        connected: hasConnections,
        client_count: this.connectionRegistry.connections.size,
        message: hasConnections ? 
          '✅ 有活跃的浏览器连接' : 
          '❌ 没有浏览器连接，请打开客户端页面'
      });
    }
    
    // 检查是否有活跃连接
    if (!this.connectionRegistry.hasActiveConnections()) {
      return this._sendErrorResponse(res, 503, 
        '❌ 没有可用的浏览器连接！\n' +
        '请确保：\n' +
        '1. 已打开浏览器客户端页面\n' + 
        '2. 已登录 Google AI Studio\n' +
        '3. 保持浏览器页面打开\n' +
        '客户端页面: https://ai.studio/apps/drive/1OQc0AcvGxeRFbc73AQKDw8AeZXhEvDzg'
      );
    }
    
    const requestId = this._generateRequestId();
    const proxyRequest = this._buildProxyRequest(req, requestId);
    
    const messageQueue = this.connectionRegistry.createMessageQueue(requestId);
    
    try {
      await this._forwardRequest(proxyRequest);
      await this._handleResponse(messageQueue, res);
    } catch (error) {
      this._handleRequestError(error, res);
    } finally {
      this.connectionRegistry.removeMessageQueue(requestId);
    }
  }
  
  _generateRequestId() {
    return `cloud_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }
  
  _buildProxyRequest(req, requestId) {
    let requestBody = '';
    if (req.body) {
      requestBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    }
    
    return {
      path: req.path,
      method: req.method,
      headers: req.headers,
      query_params: req.query,
      body: requestBody,
      request_id: requestId,
      timestamp: new Date().toISOString()
    };
  }
  
  async _forwardRequest(proxyRequest) {
    const connection = this.connectionRegistry.getFirstConnection();
    if (connection && connection.readyState === WebSocket.OPEN) {
      connection.send(JSON.stringify(proxyRequest));
      this.logger.info(`请求已转发到浏览器客户端: ${proxyRequest.request_id}`);
    } else {
      throw new Error('没有可用的WebSocket连接');
    }
  }
  
  async _handleResponse(messageQueue, res) {
    // 等待响应头
    const headerMessage = await messageQueue.dequeue();
    
    if (headerMessage.event_type === 'error') {
      return this._sendErrorResponse(res, headerMessage.status || 500, headerMessage.message);
    }
    
    // 设置响应头
    this._setResponseHeaders(res, headerMessage);
    
    // 处理流式数据
    await this._streamResponseData(messageQueue, res);
  }
  
  _setResponseHeaders(res, headerMessage) {
    res.status(headerMessage.status || 200);
    
    const headers = headerMessage.headers || {};
    Object.entries(headers).forEach(([name, value]) => {
      res.set(name, value);
    });
  }
  
  async _streamResponseData(messageQueue, res) {
    while (true) {
      try {
        const dataMessage = await messageQueue.dequeue(25000); // 25秒超时
        
        if (dataMessage.type === 'STREAM_END') {
          this.logger.info('响应流结束');
          break;
        }
        
        if (dataMessage.event_type === 'chunk' && dataMessage.data) {
          res.write(dataMessage.data);
        }
        
        if (dataMessage.event_type === 'error') {
          this.logger.error(`从浏览器收到错误: ${dataMessage.message}`);
          break;
        }
      } catch (error) {
        if (error.message === 'Queue timeout') {
          const contentType = res.get('Content-Type') || '';
          if (contentType.includes('text/event-stream')) {
            // 对于SSE连接，发送keepalive
            res.write(': keepalive\n\n');
            continue;
          } else {
            this.logger.warn('响应超时，结束流');
            break;
          }
        } else {
          this.logger.error(`流处理错误: ${error.message}`);
          break;
        }
      }
    }
    
    res.end();
  }
  
  _handleRequestError(error, res) {
    this.logger.error(`请求处理错误: ${error.message}`);
    
    if (error.message === 'Queue timeout') {
      this._sendErrorResponse(res, 504, '请求超时，请检查浏览器客户端连接');
    } else if (error.message === '没有可用的WebSocket连接') {
      this._sendErrorResponse(res, 503, '没有可用的浏览器连接');
    } else {
      this._sendErrorResponse(res, 500, `代理错误: ${error.message}`);
    }
  }
  
  _sendErrorResponse(res, status, message) {
    res.status(status).json({
      error: {
        message: message,
        type: 'proxy_error',
        status: status
      }
    });
  }
}

// 主服务器类
class CloudProxyServer extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = {
      httpPort: process.env.PORT || 10000,
      host: '0.0.0.0',
      ...config
    };
    
    this.logger = new LoggingService('CloudProxy');
    this.connectionRegistry = new ConnectionRegistry(this.logger);
    this.requestHandler = new RequestHandler(this.connectionRegistry, this.logger);
    
    this.httpServer = null;
    this.wsServer = null;
  }
  
  async start() {
    try {
      await this._startHttpServer();
      await this._startWebSocketServer();
      
      this.logger.info('🚀 云端代理服务器启动完成');
      this.logger.info(`📍 HTTP服务: http://${this.config.host}:${this.config.httpPort}`);
      this.logger.info(`🔗 WebSocket服务路径: /ws`);
      this.logger.info('💡 请打开浏览器客户端页面保持连接');
      
      this.emit('started');
    } catch (error) {
      this.logger.error(`启动失败: ${error.message}`);
      this.emit('error', error);
      throw error;
    }
  }
  
  async _startHttpServer() {
    const app = this._createExpressApp();
    this.httpServer = http.createServer(app);
    
    return new Promise((resolve, reject) => {
      this.httpServer.listen(this.config.httpPort, this.config.host, () => {
        this.logger.info(`HTTP服务器启动: http://${this.config.host}:${this.config.httpPort}`);
        resolve();
      });
      
      this.httpServer.on('error', (error) => {
        this.logger.error(`HTTP服务器启动失败: ${error.message}`);
        reject(error);
      });
    });
  }
  
  _createExpressApp() {
    const app = express();
    
    // 中间件配置
    app.use(bodyParser.json({ limit: '100mb' }));
    app.use(bodyParser.urlencoded({ extended: true, limit: '100mb' }));
    
    // 请求日志中间件
    app.use((req, res, next) => {
      this.logger.info(`收到请求: ${req.method} ${req.path}`);
      next();
    });
    
    // 所有路由都由请求处理器处理
    app.all('*', (req, res) => this.requestHandler.processRequest(req, res));
    
    // 错误处理中间件
    app.use((error, req, res, next) => {
      this.logger.error(`Express错误: ${error.message}`);
      res.status(500).json({
        error: {
          message: '内部服务器错误',
          type: 'server_error'
        }
      });
    });
    
    return app;
  }
  
  async _startWebSocketServer() {
    this.wsServer = new WebSocket.Server({
      server: this.httpServer,
      path: '/ws'
    });
    
    this.wsServer.on('connection', (ws, req) => {
      this.connectionRegistry.addConnection(ws, {
        address: req.socket.remoteAddress,
        userAgent: req.headers['user-agent']
      });
    });
    
    this.wsServer.on('error', (error) => {
      this.logger.error(`WebSocket服务器错误: ${error.message}`);
    });
    
    this.logger.info('WebSocket服务器已启动在 /ws 路径');
  }
  
  async stop() {
    this.logger.info('正在停止服务器...');
    
    if (this.wsServer) {
      this.wsServer.close();
    }
    
    if (this.httpServer) {
      this.httpServer.close();
    }
    
    this.connectionRegistry.broadcast({
      type: 'server_shutdown',
      message: '服务器正在关闭'
    });
    
    this.logger.info('服务器已停止');
  }
}

// 启动函数
async function initializeServer() {
  const serverSystem = new CloudProxyServer();
  
  // 优雅关闭处理
  process.on('SIGINT', async () => {
    console.log('\n正在关闭服务器...');
    await serverSystem.stop();
    process.exit(0);
  });
  
  process.on('SIGTERM', async () => {
    console.log('收到SIGTERM信号，正在关闭服务器...');
    await serverSystem.stop();
    process.exit(0);
  });
  
  try {
    await serverSystem.start();
    console.log('\n🎯 云端代理服务器已启动！');
    console.log('💡 使用说明:');
    console.log('1. 打开浏览器客户端页面: https://ai.studio/apps/drive/1OQc0AcvGxeRFbc73AQKDw8AeZXhEvDzg');
    console.log('2. 在SillyTavern中配置API地址为你的HF Space URL');
    console.log('3. 选择 gemini-pro 或 gemini-2.5-pro 模型');
    console.log('4. 保持浏览器页面打开以维持连接\n');
  } catch (error) {
    console.error('❌ 服务器启动失败:', error.message);
    process.exit(1);
  }
}

// 模块导出和启动
if (require.main === module) {
  initializeServer();
}

module.exports = { CloudProxyServer, initializeServer, LoggingService, ConnectionRegistry };