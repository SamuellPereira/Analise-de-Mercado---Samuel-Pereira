const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
// Carrega variáveis do arquivo .env sem dependências externas.
// Variáveis já definidas no ambiente têm prioridade.
const ENV_FILE = path.join(__dirname, '.env');
if (fs.existsSync(ENV_FILE)) {
  const envText = fs.readFileSync(ENV_FILE, 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const name = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (name && process.env[name] === undefined) process.env[name] = value;
  }
}
const PORT = process.env.PORT || 3001;
const ROOT = __dirname;
const cache = new Map();
const TTL = 60_000;

async function cached(key, loader, ttl = TTL) {
  const old = cache.get(key);
  if (old && Date.now() - old.time < ttl) return old.value;
  const value = await loader();
  cache.set(key, { time: Date.now(), value });
  return value;
}
function send(res, status, data, type='application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
}
async function yahooChart(symbol, range='3mo', interval='1d') {
  const allowedRanges = new Set(['1mo','3mo','6mo','1y']);
  const allowedIntervals = new Set(['1d','1wk']);
  if (!allowedRanges.has(range)) range='3mo';
  if (!allowedIntervals.has(interval)) interval='1d';
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&events=history`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 AnaliseDeMercado/1.0' } });
  if (!r.ok) throw new Error(`Fonte de cotações respondeu ${r.status}`);
  const json = await r.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(json?.chart?.error?.description || 'Ativo não encontrado na fonte de dados.');
  const q = result.indicators?.quote?.[0] || {};
  const prices = (result.timestamp || []).map((t, i) => ({
    date: new Date(t * 1000).toISOString().slice(0,10),
    close: q.close?.[i] == null ? null : Number(q.close[i]),
    volume: q.volume?.[i] == null ? 0 : Number(q.volume[i])
  })).filter(p => Number.isFinite(p.close) && p.close > 0);
  return {
    symbol: result.meta?.symbol || symbol,
    currency: result.meta?.currency || (symbol.endsWith('.SA') ? 'BRL' : 'USD'),
    exchange: result.meta?.exchangeName || '',
    current: result.meta?.regularMarketPrice ?? prices.at(-1)?.close ?? null,
    previousClose: result.meta?.chartPreviousClose ?? prices.at(-2)?.close ?? null,
    updatedAt: new Date().toISOString(), prices
  };
}

async function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 100_000) { reject(new Error('Pedido muito grande.')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('JSON inválido.')); } });
    req.on('error', reject);
  });
}
async function geminiAnalysis(payload) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { status: 503, data: { error: 'A IA generativa ainda não está configurada.', hint: 'Configure uma chave gratuita do Google AI Studio na variável GEMINI_API_KEY e reinicie o servidor. Até lá, o site usa apenas análise técnica por regras.' } };
  const safeAssets = Array.isArray(payload.assets) ? payload.assets.slice(0, 8).map(a => ({
    name: String(a.name || '').slice(0, 80), ticker: String(a.ticker || '').slice(0, 20),
    market: String(a.market || '').slice(0, 20), currency: String(a.currency || '').slice(0, 8),
    price: Number(a.price), dailyChangePct: Number(a.change), score: Number(a.score),
    signal: String(a.signal || '').slice(0, 30), trend: String(a.trend || '').slice(0, 30),
    risk: String(a.risk || '').slice(0, 30), reasons: Array.isArray(a.reasons) ? a.reasons.slice(0, 4).map(x => String(x).slice(0, 180)) : [],
    scenarios: Array.isArray(a.projections) ? a.projections.slice(0, 3).map(x => ({ days: Number(x.days), estimatedPct: Number(x.base), lowPct: Number(x.low), highPct: Number(x.high) })) : []
  })).filter(a => a.name && Number.isFinite(a.score)) : [];
  if (!safeAssets.length) return { status: 400, data: { error: 'Ainda não há dados suficientes para analisar. Atualize as cotações e tente novamente.' } };
  const prompt = `Você é a analista do site Analise de Mercado - Samuel Pereira. Fale em português brasileiro claro, como uma pessoa explicando a um iniciante. Seja direta, específica e honesta. Use SOMENTE os dados enviados; não invente preços, indicadores, notícias, fundamentos, eventos ou probabilidades. Uma pontuação técnica não é uma probabilidade de lucro e desempenho passado não garante retorno futuro.

Responda com estes títulos, nesta ordem:

1. RESUMO DO MERCADO
Em 2-3 frases: o cenário observado está FAVORÁVEL, MISTO ou DESFAVORÁVEL para procurar oportunidades? Explique por quê e diga se os dados são suficientes. Não confunda mercado em alta com investimento seguro.

2. MELHOR OPÇÃO ENTRE AS ANALISADAS
Escolha o ativo com os sinais técnicos mais favoráveis entre os dados fornecidos. Informe nome, pontuação/sinal e 2-3 motivos concretos. Se os dados não sustentarem uma boa oportunidade, diga claramente "Nenhuma oportunidade forte identificada". Não chame isso de recomendação personalizada nem mande comprar.

3. ATIVO QUE EXIGE MAIS CUIDADO
Indique o sinal mais fraco e explique os riscos observados, sem afirmar que a queda é certa.

4. CENÁRIOS DE GANHO E QUEDA
Explique que cenários são hipóteses, não previsões garantidas. Cubra estes prazos para o mercado brasileiro: 1 mês, 5 meses, 9 meses, 1 ano, 2 anos, 3 anos e 4 anos.
- Para cada prazo, descreva cenário positivo, neutro e negativo e quais fatores poderiam levar a ganhos ou perdas.
- Só informe percentuais ou valores numéricos quando puder derivá-los dos dados fornecidos ou de uma metodologia explícita presente neles. Não invente faixas de retorno.
- Se os dados atuais não incluírem histórico suficiente, volatilidade, fundamentos e contexto macroeconômico para estimar um prazo, diga isso explicitamente e descreva o cenário qualitativamente, sem criar números.
- Diferencie o curto prazo técnico do longo prazo, que depende de juros, inflação, câmbio, resultados das empresas e outros fatores não fornecidos.

5. EXEMPLO EM REAIS
Se não houver valor investido informado, use R$ 1.000 apenas como exemplo didático. Faça contas de ganho/perda somente para percentuais sustentados pelos dados; caso contrário, mostre a fórmula: valor final = investimento × (1 + retorno hipotético). Identifique sempre que é simulação, antes de taxas e impostos.

6. CONCLUSÃO
Diga em uma frase o que vale acompanhar e o que poderia invalidar a leitura. Reforce que não é aconselhamento financeiro individual.

Dados disponíveis (podem estar incompletos): ${JSON.stringify(safeAssets)}`;
  // Gemini Interactions API (recomendada para novas integrações).
  const url = 'https://generativelanguage.googleapis.com/v1beta/interactions';
  let response, json = {};
  // Repetições limitadas para falhas transitórias de alta demanda (503) ou limite (429).
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        signal: AbortSignal.timeout(18000),
        body: JSON.stringify({
          model: 'gemini-3.8-flash',
          store: false,
          input: prompt,
          generation_config: { temperature: 0.2, max_output_tokens: 1600 }
        })
      });
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        return { status: 504, data: { error: 'A análise demorou mais que o esperado.', hint: 'O serviço de IA não respondeu a tempo. Tente novamente daqui a pouco; seus indicadores técnicos continuam disponíveis.' } };
      }
      return { status: 502, data: { error: 'Não foi possível conectar ao serviço de IA.', hint: 'Confira sua conexão e tente novamente. Os dados de mercado continuam disponíveis.' } };
    }
    json = await response.json().catch(() => ({}));
    if (response.ok || ![429, 503].includes(response.status) || attempt === 2) break;
    await new Promise(resolve => setTimeout(resolve, 1200 * (attempt + 1)));
  }
  if (!response.ok) {
    const apiMessage = json?.error?.message || json?.message || 'Não foi possível obter a análise da IA.';
    let hint = 'Confira a configuração da API e tente novamente.';
    if (response.status === 503) hint = 'O Gemini está temporariamente sobrecarregado. Aguarde um pouco e clique em “Analisar com IA” novamente. Sua chave não precisa ser alterada por esse erro.';
    else if (response.status === 429) hint = 'A API informou limite de uso ou cota. Aguarde a redefinição do limite e confira o uso no Google AI Studio.';
    else if (response.status === 401 || response.status === 403) hint = 'A autenticação foi recusada. Confira GEMINI_API_KEY e as permissões do projeto.';
    else if (response.status === 400) hint = 'A API rejeitou os parâmetros enviados. Confira o modelo e o formato da solicitação.';
    const status = [400, 401, 403, 429, 503].includes(response.status) ? response.status : 502;
    return { status, data: { error: apiMessage, hint } };
  }
  const text = (json?.steps || [])
    .filter(step => step.type === 'model_output')
    .flatMap(step => step.content || [])
    .filter(block => block.type === 'text')
    .map(block => block.text || '')
    .join('\n').trim() || String(json?.output_text || '').trim();
  if (!text) return { status: 502, data: { error: 'A IA não retornou uma análise utilizável.', hint: 'Tente novamente em instantes.' } };
  return { status: 200, data: { analysis: text, model: json?.model || 'gemini-3.8-flash', generatedAt: new Date().toISOString() } };
}

async function stockUniverse() {
  const token = process.env.BRAPI_TOKEN;
  const headers = { accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const url = 'https://brapi.dev/api/quote/list?type=stock&sortBy=volume&sortOrder=desc&limit=1000&page=1';
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`A lista de ações respondeu ${r.status}. Confira BRAPI_TOKEN no .env ou tente mais tarde.`);
  const json = await r.json();
  const rows = Array.isArray(json.stocks) ? json.stocks : [];
  if (!rows.length) throw new Error('A fonte não retornou uma lista de ações.');
  return rows.map(x => ({
    ticker: `${String(x.stock || '').replace(/\.SA$/i, '')}.SA`,
    name: String(x.name || x.stock || '').trim(),
    price: Number(x.close ?? x.price ?? x.regularMarketPrice),
    change: Number(x.change ?? x.regularMarketChangePercent ?? 0),
    volume: Number(x.volume || 0),
    currency: 'BRL',
    marketCap: Number(x.market_cap || x.marketCap || 0),
    sector: String(x.sector || ''),
    source: 'brapi'
  })).filter(x => /^[A-Z0-9]{4,7}\.SA$/.test(x.ticker) && Number.isFinite(x.price) && x.price > 0);
}

async function cryptoMarkets() {
  const url = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=true&price_change_percentage=24h,7d';
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`CoinGecko respondeu ${r.status}. Tente novamente em instantes.`);
  return r.json();
}
async function cryptoChart(id, days='90') {
  if (!/^\d+$/.test(days) || !['7','30','90','180','365'].includes(days)) days='90';
  const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=${days}&interval=daily`;
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`CoinGecko respondeu ${r.status}. Tente novamente em instantes.`);
  const j = await r.json();
  const vols = new Map((j.total_volumes || []).map(x => [new Date(x[0]).toISOString().slice(0,10), x[1]]));
  return { id, currency: 'USD', updatedAt: new Date().toISOString(), prices: (j.prices || []).map(([t,p]) => ({ date: new Date(t).toISOString().slice(0,10), close: Number(p), volume: Number(vols.get(new Date(t).toISOString().slice(0,10)) || 0) })).filter(x => x.close > 0) };
}
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml', '.json':'application/json; charset=utf-8' };
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (u.pathname === '/api/ai-analysis' && req.method === 'POST') {
      const payload = await readJson(req);
      const result = await geminiAnalysis(payload);
      return send(res, result.status, result.data);
    }
    if (u.pathname === '/api/stock-universe') {
      const data = await cached('stock-universe', stockUniverse, 15000);
      return send(res, 200, { stocks: data, updatedAt: new Date().toISOString(), count: data.length, source: 'brapi.dev' });
    }
    if (u.pathname === '/api/stock') {
      const symbol = (u.searchParams.get('symbol') || 'PETR4.SA').toUpperCase().replace(/[^A-Z0-9.^=-]/g, '');
      if (!symbol || symbol.length > 20) return send(res, 400, { error: 'Símbolo inválido.' });
      const data = await cached(`stock:${symbol}:${u.searchParams.get('range')}:${u.searchParams.get('interval')}`, () => yahooChart(symbol, u.searchParams.get('range'), u.searchParams.get('interval')));
      return send(res, 200, data);
    }
    if (u.pathname === '/api/crypto') {
      const data = await cached('crypto:markets', cryptoMarkets);
      return send(res, 200, data);
    }
    if (u.pathname === '/api/crypto-chart') {
      const id = (u.searchParams.get('id') || 'bitcoin').toLowerCase().replace(/[^a-z0-9-]/g, '');
      const data = await cached(`crypto-chart:${id}:${u.searchParams.get('days')}`, () => cryptoChart(id, u.searchParams.get('days')));
      return send(res, 200, data);
    }
    let file = u.pathname === '/' ? 'index.html' : path.normalize(decodeURIComponent(u.pathname)).replace(/^([/\\])+/, '');
    const full = path.join(ROOT, file);
    if (!full.startsWith(ROOT)) return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
    fs.readFile(full, (err, body) => err ? send(res, 404, 'Not found', 'text/plain; charset=utf-8') : send(res, 200, body, mime[path.extname(full)] || 'application/octet-stream'));
  } catch (e) {
    send(res, 502, { error: e.message || 'Não foi possível consultar a fonte de dados.', hint: 'Confira sua conexão e tente novamente. APIs gratuitas podem limitar requisições.' });
  }
});
server.listen(PORT, () => console.log(`Analise de Mercado - Samuel Pereira rodando em http://localhost:${PORT}`));
