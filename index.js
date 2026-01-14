const express = require('express');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

// OAuth2 설정
const oauth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET
);
oauth2Client.setCredentials({
  refresh_token: process.env.REFRESH_TOKEN
});

const drive = google.drive({ version: 'v3', auth: oauth2Client });

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// MCP Tools 정의
const tools = [
  {
    name: 'gdrive_upload',
    description: 'Upload a markdown file to Google Drive',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Filename (e.g., prompt.md)' },
        content: { type: 'string', description: 'File content' },
        folderId: { type: 'string', description: 'Optional folder ID' }
      },
      required: ['filename', 'content']
    }
  },
  {
    name: 'gdrive_list',
    description: 'List files in Google Drive',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        folderId: { type: 'string', description: 'Folder ID' }
      }
    }
  }
];

// Tool 실행 함수
async function executeTool(name, args) {
  if (name === 'gdrive_upload') {
    const { filename, content, folderId } = args;
    const fileMetadata = {
      name: filename,
      ...(folderId && { parents: [folderId] })
    };
    const media = {
      mimeType: 'text/markdown',
      body: require('stream').Readable.from([content])
    };
    const file = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id, webViewLink'
    });
    await drive.permissions.create({
      fileId: file.data.id,
      requestBody: { role: 'reader', type: 'anyone' }
    });
    return { fileId: file.data.id, link: file.data.webViewLink };
  }
  
  if (name === 'gdrive_list') {
    const { query, folderId } = args;
    let q = "trashed=false";
    if (folderId) q += ` and '${folderId}' in parents`;
    if (query) q += ` and name contains '${query}'`;
    const res = await drive.files.list({
      q,
      fields: 'files(id, name, webViewLink)',
      pageSize: 20
    });
    return { files: res.data.files };
  }
  
  throw new Error(`Unknown tool: ${name}`);
}

// SSE 엔드포인트 (Claude.ai MCP 커넥터용)
app.get('/mcp', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // 초기 연결 메시지
  const initMessage = {
    jsonrpc: '2.0',
    method: 'initialized',
    params: { protocolVersion: '2024-11-05' }
  };
  res.write(`data: ${JSON.stringify(initMessage)}\n\n`);

  // Keep-alive
  const keepAlive = setInterval(() => {
    res.write(': ping\n\n');
  }, 30000);

  req.on('close', () => {
    clearInterval(keepAlive);
  });
});

// MCP POST 엔드포인트
app.post('/mcp', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { method, params, id } = req.body;

  try {
    if (method === 'initialize') {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'gdrive-mcp-server', version: '1.0.0' },
          capabilities: { tools: {} }
        }
      });
    }

    if (method === 'tools/list') {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: { tools }
      });
    }

    if (method === 'tools/call') {
      const { name, arguments: args } = params;
      const result = await executeTool(name, args || {});
      return res.json({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      });
    }

    res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  } catch (error) {
    res.json({ jsonrpc: '2.0', id, error: { code: -32000, message: error.message } });
  }
});

// CORS preflight
app.options('/mcp', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

// 기존 REST 엔드포인트 (테스트용)
app.get('/mcp/tools', (req, res) => {
  res.json({ tools });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`GDrive MCP Server running on port ${PORT}`);
});
