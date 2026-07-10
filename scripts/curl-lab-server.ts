import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { runThreatIntake } from '../engine/threat-intake.js';
import { writeDefense } from '../engine/defense-writer.js';

let PORT = Number(process.env.PORT) || 3000;

const server = http.createServer((req, res) => {
  // Set CORS headers so it can be queried from browser dashboards if needed
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  console.log(`\n=== 📥 Incoming Request: [${req.method}] ${req.url} ===`);
  console.log('--- Headers ---');
  console.log(JSON.stringify(req.headers, null, 2));

  let bodyChunks: Buffer[] = [];
  req.on('data', (chunk) => {
    bodyChunks.push(chunk);
  });

  req.on('end', () => {
    const rawBody = Buffer.concat(bodyChunks);
    const bodyString = rawBody.toString('utf-8');

    console.log('--- Raw Body Content ---');
    if (bodyString.length > 0) {
      // If it looks like binary or very large multipart, truncate for screen sanity
      if (bodyString.length > 2000) {
        console.log(bodyString.substring(0, 1000) + `\n... [Truncated ${bodyString.length - 1000} bytes] ...`);
      } else {
        console.log(bodyString);
      }
    } else {
      console.log('[Empty Body]');
    }
    console.log('==============================================\n');

    // Route logic
    const parsedUrl = new URL(req.url || '/', `http://localhost:${PORT}`);
    const pathname = parsedUrl.pathname;

    if (pathname === '/favicon.ico') {
      res.writeHead(404);
      res.end();
      return;
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Lab-Server-Version', '1.0.0');

    // Simulate different header conditions for learning
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    // Strip away HTTP camouflage and only embed the actual code payload
    let payload = bodyString;
    try {
      const parsed = JSON.parse(bodyString);
      if (parsed.data) payload = parsed.data;
    } catch(e) {}


    // Resolve threat domain from header option or default to source-audit
    let domain: any = 'source-audit';
    const headerDomain = req.headers['x-threat-domain'];
    if (headerDomain && typeof headerDomain === 'string') {
      const allowed = ['roblox-luau', 'finance-crypto', 'source-audit', 'general', 'memory', 'reddit'];
      if (allowed.includes(headerDomain)) {
        domain = headerDomain;
      }
    }

    console.log(`[geometric-gate] Inspecting request to [${req.method}] ${pathname} under domain '${domain}'...`);

    const tStart = performance.now();

    runThreatIntake(payload, domain).then(async (report) => {
      const tEnd = performance.now();
      const durationMs = tEnd - tStart;

      console.log(`[geometric-gate] Analysis complete: report ${report.id}`);
      console.log(`  Shatter: ${report.shatter.toFixed(4)} | Classification: ${report.classification}`);
      console.log(`  Processing time: ${durationMs.toFixed(2)}ms`);

      // Inject telemetry results into headers of all responses
      res.setHeader('X-Shatter-Score', report.shatter.toFixed(4));
      res.setHeader('X-Threat-Classification', report.classification);
      res.setHeader('X-Threat-Report-ID', report.id);
      res.setHeader('X-Threat-Domain', domain);
      res.setHeader('X-Pipeline-Time-Ms', durationMs.toFixed(2));

      if (report.classification === 'THREAT' || report.classification === 'WATCH') {
        console.log(`[geometric-gate] High-shatter payload detected. Invoking defense-writer...`);
        const bundle = await writeDefense(report);
        if (bundle) {
          console.log(`[geometric-gate] Defense bundle written to: ${bundle.reportPath}`);
        }
      }

      handleRouting(pathname, req, res, bodyString, rawBody, report);
    }).catch(err => {
      console.error(`[geometric-gate] Threat check failed:`, err.message);
      console.error(`  HINT: Make sure local Ollama is running (http://localhost:11434) and mxbai-embed-large is pulled: 'ollama pull mxbai-embed-large'`);

      res.setHeader('X-Shatter-Score', '0.0000');
      res.setHeader('X-Threat-Classification', 'OFFLINE');
      handleRouting(pathname, req, res, bodyString, rawBody, null);
    });
  });
});

function handleRouting(
  pathname: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  bodyString: string,
  rawBody: Buffer,
  report: any
) {
  if (pathname === '/headers') {
    res.writeHead(200);
    res.end(JSON.stringify({
      message: 'Headers inspected successfully!',
      clientHeaders: req.headers,
      ...(report ? { geometricAudit: { shatter: report.shatter, classification: report.classification } } : {})
    }, null, 2));
    return;
  }

  if (pathname === '/upload' || pathname === '/post') {
    res.writeHead(200);
    
    // Parse Content-Type to help client understand
    const contentType = req.headers['content-type'] || '';
    let parsedBody: any = null;

    if (contentType.includes('application/json')) {
      try {
        parsedBody = JSON.parse(bodyString);
      } catch (e) {
        parsedBody = { error: 'Invalid JSON payload' };
      }
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      parsedBody = Object.fromEntries(new URLSearchParams(bodyString).entries());
    } else if (contentType.includes('multipart/form-data')) {
      // Quick multipart boundary parsing for demo
      const boundaryMatch = contentType.match(/boundary=(.+)/);
      if (boundaryMatch) {
        const boundary = boundaryMatch[1];
        parsedBody = {
          info: 'Received Multipart data!',
          boundary: boundary,
          totalBytes: rawBody.length,
          preview: bodyString.substring(0, 500)
        };
      }
    }

    res.end(JSON.stringify({
      status: 'success',
      receivedMethod: req.method,
      receivedContentType: contentType,
      parsedData: parsedBody,
      rawLength: rawBody.length,
      ...(report ? { geometricAudit: { shatter: report.shatter, classification: report.classification } } : {})
    }, null, 2));
    return;
  }

  // Fallback dynamic route (accepts any custom URL path)
  res.writeHead(200);
  res.end(JSON.stringify({
    message: `Processed request to path: ${pathname}`,
    receivedMethod: req.method,
    receivedHeaders: req.headers,
    receivedBodyLength: rawBody.length,
    geometricAudit: report ? {
      shatterScore: report.shatter,
      classification: report.classification,
      reportId: report.id
    } : { status: 'offline' },
    hint: 'You can query ANY path (e.g., /api/users, /v1/auth) and the threat pipeline will dynamically analyze it.'
  }, null, 2));
}

function startServer(port: number) {
  server.listen(port, () => {
    console.log(`🚀 curl Lab Server listening on http://localhost:${port}`);
    console.log(`Press Ctrl+C to terminate the server.`);
  });
}

server.on('error', (err: any) => {
  if (err.code === 'EADDRINUSE') {
    console.warn(`⚠️ Port ${PORT} is already in use. Retrying on port ${PORT + 1}...`);
    PORT++;
    startServer(PORT);
  } else {
    console.error('Server error:', err);
  }
});

startServer(PORT);
