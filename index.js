import express from 'express';
import { google } from 'googleapis';
import { Readable } from 'stream';

const app = express();
app.use(express.json({ limit: '10mb' }));

// OAuth2 클라이언트 설정
const oauth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET
);

oauth2Client.setCredentials({
  refresh_token: process.env.REFRESH_TOKEN
});

const drive = google.drive({ version: 'v3', auth: oauth2Client });

// 파일 업로드 함수
async function uploadFile(filename, content, folderId) {
  const fileMetadata = {
    name: filename,
    mimeType: 'text/markdown'
  };
  
  if (folderId) {
    fileMetadata.parents = [folderId];
  }

  const stream = new Readable();
  stream.push(content);
  stream.push(null);

  const media = {
    mimeType: 'text/markdown',
    body: stream
  };

  const response = await drive.files.create({
    requestBody: fileMetadata,
    media: media,
    fields: 'id, name, webViewLink'
  });

  await drive.permissions.create({
    fileId: response.data.id,
    requestBody: {
      role: 'reader',
      type: 'anyone'
    }
  });

  return response.data;
}

// 파일 목록 조회 함수
async function listFiles(query, folderId) {
  let q = query || '';
  if (folderId) {
    q = q ? `${q} and '${folderId}' in parents` : `'${folderId}' in parents`;
  }

  const response = await drive.files.list({
    q: q,
    fields: 'files(id, name, webViewLink, createdTime)',
    orderBy: 'createdTime desc',
    pageSize: 20
  });

  return response.data.files;
}

// MCP SSE 엔드포인트
app.get('/mcp', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.write(`data: ${JSON.stringify({ type: 'ready' })}\n\n`);
});

// 도구 목록
app.get('/mcp/tools', (req, res) => {
  res.json({
    tools: [
      {
        name: "gdrive_upload",
        description: "Upload a markdown file to Google Drive",
        inputSchema: {
          type: "object",
          properties: {
            filename: { type: "string", description: "Filename (e.g., prompt.md)" },
            content: { type: "string", description: "File content" },
            folderId: { type: "string", description: "Optional folder ID" }
          },
          required: ["filename", "content"]
        }
      },
      {
        name: "gdrive_list",
        description: "List files in Google Drive",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            folderId: { type: "string", description: "Folder ID" }
          }
        }
      }
    ]
  });
});

// 도구 실행
app.post('/mcp/tools/:toolName', async (req, res) => {
  const { toolName } = req.params;
  const params = req.body;

  try {
    let result;
    if (toolName === 'gdrive_upload') {
      result = await uploadFile(params.filename, params.content, params.folderId);
    } else if (toolName === 'gdrive_list') {
      result = await listFiles(params.query, params.folderId);
    } else {
      return res.status(404).json({ error: `Tool ${toolName} not found` });
    }
    res.json({ result });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 헬스 체크
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`GDrive MCP Server running on port ${PORT}`);
});
