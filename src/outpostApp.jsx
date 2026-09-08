import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Trophy, Medal, Plus, Check, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight,
  ThumbsUp, Send, LogOut, Loader2, AlertCircle, Lock, Search, Swords,
  Info, CheckCircle2, Pencil, ArrowLeft, Sparkles, Flag, Ban, Shield, ExternalLink, FolderOpen, ChevronDown, List, BookOpen, PlusCircle, X, Clock
} from "lucide-react";

/* ============================================================================
   CONSTANTS
============================================================================ */

const REVIEW_GAP = 300;
const MAX_REVIEWS = 10;
const MIN_REVIEW_CHARS = 50;

const WHITE_GLYPH = { P: "♙", N: "♘", B: "♗", R: "♖", Q: "♕", K: "♔" };
const BLACK_GLYPH = { P: "♟", N: "♞", B: "♝", R: "♜", Q: "♛", K: "♚" };
const localStor = new Map();
const RATING_TIERS = [
  { max: 999, label: "Club", color: "#8B8578" },
  { max: 1399, label: "Intermediate", color: "#4C7A5D" },
  { max: 1799, label: "Advanced", color: "#2F6FA6" },
  { max: 2199, label: "Expert", color: "#A34E36" },
  { max: Infinity, label: "Master", color: "#C79A4B" },
];

function ratingTier(rating) {
  return RATING_TIERS.find((t) => rating <= t.max) || RATING_TIERS[RATING_TIERS.length - 1];
}

const SECOND_TIERS = [
  { min: 0, label: "New Second" },
  { min: 3, label: "Second" },
  { min: 10, label: "Trusted Second" },
  { min: 30, label: "Senior Second" },
  { min: 75, label: "Head Second" },
];
function secondTier(score) {
  let cur = SECOND_TIERS[0];
  for (const t of SECOND_TIERS) if (score >= t.min) cur = t;
  return cur.label;
}

/* ============================================================================
   CHESS ENGINE — board model + SAN replay
============================================================================ */

function initialBoard() {
  const back = ["R", "N", "B", "Q", "K", "B", "N", "R"];
  const b = Array.from({ length: 8 }, () => Array(8).fill(null));
  for (let c = 0; c < 8; c++) {
    b[0][c] = "b" + back[c];
    b[1][c] = "bP";
    b[6][c] = "wP";
    b[7][c] = "w" + back[c];
  }
  return b;
}
function sqToRC(sq) {
  const file = sq.charCodeAt(0) - "a".charCodeAt(0);
  const rank = parseInt(sq[1], 10);
  return [8 - rank, file];
}
function rcToSq(r, c) {
  return String.fromCharCode("a".charCodeAt(0) + c) + (8 - r);
}
function cloneBoard(b) {
  return b.map((row) => row.slice());
}
function tokenizeMoves(pgn) {
  let s = pgn;
  s = s.replace(/\[[^\]]*\]/g, " ");
  s = s.replace(/\{[^}]*\}/g, " ");
  let prev;
  do {
    prev = s;
    s = s.replace(/\([^()]*\)/g, " ");
  } while (s !== prev);
  s = s.replace(/\$\d+/g, " ");
  s = s.replace(/\d+\.(\.\.)?/g, " ");
  s = s.replace(/1-0|0-1|1\/2-1\/2|\*/g, " ");
  return s.split(/\s+/).map((t) => t.trim()).filter(Boolean);
}
function pieceColor(p) { return p ? p[0] : null; }
function pieceType(p) { return p ? p[1] : null; }
function isPathClear(board, r1, c1, r2, c2) {
  const dr = Math.sign(r2 - r1), dc = Math.sign(c2 - c1);
  let r = r1 + dr, c = c1 + dc;
  while (r !== r2 || c !== c2) {
    if (board[r][c]) return false;
    r += dr; c += dc;
  }
  return true;
}
function findCandidates(board, color, type, destR, destC, hintFile, hintRank) {
  const candidates = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p || pieceColor(p) !== color || pieceType(p) !== type) continue;
      if (hintFile !== null && c !== hintFile) continue;
      if (hintRank !== null && 8 - r !== hintRank) continue;
      let reaches = false;
      if (type === "N") {
        const dr = Math.abs(r - destR), dc = Math.abs(c - destC);
        reaches = (dr === 1 && dc === 2) || (dr === 2 && dc === 1);
      } else if (type === "B") {
        reaches = Math.abs(r - destR) === Math.abs(c - destC) && isPathClear(board, r, c, destR, destC);
      } else if (type === "R") {
        reaches = (r === destR || c === destC) && isPathClear(board, r, c, destR, destC);
      } else if (type === "Q") {
        reaches = (r === destR || c === destC || Math.abs(r - destR) === Math.abs(c - destC)) && isPathClear(board, r, c, destR, destC);
      } else if (type === "K") {
        reaches = Math.abs(r - destR) <= 1 && Math.abs(c - destC) <= 1;
      }
      if (reaches) candidates.push([r, c]);
    }
  }
  return candidates;
}
function applySAN(board, turn, rawSan) {
  let san = rawSan.replace(/[+#!?]+$/g, "").replace(/[!?]+/g, "");
  const color = turn;

  if (san === "O-O" || san === "0-0") {
    const row = color === "w" ? 7 : 0;
    board[row][6] = board[row][4]; board[row][4] = null;
    board[row][5] = board[row][7]; board[row][7] = null;
    return { board, from: rcToSq(row, 4), to: rcToSq(row, 6) };
  }
  if (san === "O-O-O" || san === "0-0-0") {
    const row = color === "w" ? 7 : 0;
    board[row][2] = board[row][4]; board[row][4] = null;
    board[row][3] = board[row][0]; board[row][0] = null;
    return { board, from: rcToSq(row, 4), to: rcToSq(row, 2) };
  }

  let promotion = null;
  const promoMatch = san.match(/=([NBRQ])$/);
  if (promoMatch) { promotion = promoMatch[1]; san = san.slice(0, san.length - 2); }

  const pieceMatch = san.match(/^([NBRQK])/);
  const type = pieceMatch ? pieceMatch[1] : "P";
  let rest = pieceMatch ? san.slice(1) : san;
  const isCapture = rest.includes("x");
  rest = rest.replace("x", "");

  const dest = rest.slice(-2);
  const disamb = rest.slice(0, -2);
  let hintFile = null, hintRank = null;
  for (const ch of disamb) {
    if (ch >= "a" && ch <= "h") hintFile = ch.charCodeAt(0) - "a".charCodeAt(0);
    else if (ch >= "1" && ch <= "8") hintRank = parseInt(ch, 10);
  }
  const [destR, destC] = sqToRC(dest);

  if (type === "P") {
    let srcR, srcC;
    if (isCapture) {
      srcC = hintFile;
      srcR = color === "w" ? destR + 1 : destR - 1;
      if (!board[destR][destC]) board[srcR][destC] = null; // en passant
    } else {
      srcC = destC;
      const oneBack = color === "w" ? destR + 1 : destR - 1;
      const twoBack = color === "w" ? destR + 2 : destR - 2;
      srcR = board[oneBack] && board[oneBack][srcC] === color + "P" ? oneBack : twoBack;
    }
    const moved = board[srcR][srcC];
    board[srcR][srcC] = null;
    board[destR][destC] = promotion ? color + promotion : moved;
    return { board, from: rcToSq(srcR, srcC), to: rcToSq(destR, destC) };
  }
  const candidates = findCandidates(board, color, type, destR, destC, hintFile, hintRank);
  if (candidates.length === 0) throw new Error(`Unrecognized move: ${rawSan}`);
  const [sr, sc] = candidates[0];
  board[sr][sc] = null;
  board[destR][destC] = color + type;
  return { board, from: rcToSq(sr, sc), to: rcToSq(destR, destC) };
}
function parsePGNHeaders(pgn) {
  const headers = {};
  const re = /\[(\w+)\s+"([^"]*)"\]/g;
  let m;
  while ((m = re.exec(pgn)) !== null) headers[m[1]] = m[2];
  return headers;
}
function parseFEN(fen) {
  const parts = fen.trim().split(/\s+/);
  const rows = parts[0].split("/");
  const board = Array.from({ length: 8 }, () => Array(8).fill(null));
  const map = { p: "P", n: "N", b: "B", r: "R", q: "Q", k: "K" };
  for (let r = 0; r < 8; r++) {
    let c = 0;
    for (const ch of rows[r]) {
      if (/\d/.test(ch)) c += parseInt(ch, 10);
      else {
        const color = ch === ch.toUpperCase() ? "w" : "b";
        board[r][c] = color + map[ch.toLowerCase()];
        c += 1;
      }
    }
  }
  return { board, turn: parts[1] === "b" ? "b" : "w" };
}
function replayPGN(pgn) {
  const headers = parsePGNHeaders(pgn);
  const tokens = tokenizeMoves(pgn);
  let board = initialBoard();
  let turn = "w";
  if (headers.FEN) {
    const parsed = parseFEN(headers.FEN);
    board = parsed.board;
    turn = parsed.turn;
  }
  const positions = [cloneBoard(board)];
  const moves = [];
  let moveNumber = headers.FEN ? parseInt(headers.FEN.trim().split(/\s+/)[5] || "1", 10) : 1;
  const errors = [];
  for (const tok of tokens) {
    if (!tok || /^\d/.test(tok)) continue;
    const color = turn;
    try {
      const result = applySAN(board, turn, tok);
      board = result.board;
      positions.push(cloneBoard(board));
      moves.push({ san: tok, from: result.from, to: result.to, color, moveNumber });
    } catch (e) {
      errors.push(tok);
      break;
    }
    if (color === "b") moveNumber += 1;
    turn = turn === "w" ? "b" : "w";
  }
  return { positions, moves, headers, errors };
}

/* ============================================================================
   STORAGE HELPERS (optimized with bulkGet)
============================================================================ */

async function callStorage(body) {
  const res = await fetch('/api/storage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('Storage request failed');
  return res.json();
}

async function storageGet(key, shared) {
  return callStorage({ action: 'get', key, shared });
}
async function storageSet(key, value, shared) {
  return callStorage({ action: 'set', key, value, shared });
}
async function storageList(prefix, shared) {
  return callStorage({ action: 'list', prefix, shared });
}
async function storageDelete(key, shared) {
  return callStorage({ action: 'delete', key, shared });
}
async function storageBulkGet(keys, shared) {
  if (!Array.isArray(keys) || keys.length === 0) return [];
  return callStorage({ action: 'bulkGet', keys, shared });
}

const gameKey = (id) => `games:${id}`;
const reviewKey = (gameId, uid) => `reviews:${gameId}:${uid}`;
const reviewPrefix = (gameId) => `reviews:${gameId}:`;
const userKey = (uid) => `users:${uid}`;
const reportKey = (id) => `reports:${id}`;

function normalizeId(username) {
  return username.trim().toLowerCase().replace(/\s+/g, "");
}
function newGameId() {
  return `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
function newReportId() {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/* ============================================================================
   EXTERNAL FETCH HELPERS
============================================================================ */

async function fetchLichessProfile(username) {
  const res = await fetch(`https://lichess.org/api/user/${encodeURIComponent(username)}`);
  if (!res.ok) throw new Error(res.status === 404 ? "No Lichess account with that username." : `Lichess API error (${res.status}).`);
  const data = await res.json();
  const perfs = data.perfs || {};
  const order = ["blitz", "rapid", "classical", "bullet", "correspondence"];
  const variants = order
    .filter((v) => perfs[v] && perfs[v].games > 0 && !perfs[v].prov)
    .map((v) => ({ variant: v, rating: perfs[v].rating, games: perfs[v].games }));
  if (variants.length === 0) {
    for (const v of order) {
      if (perfs[v] && typeof perfs[v].rating === "number") {
        variants.push({ variant: v, rating: perfs[v].rating, games: perfs[v].games || 0 });
      }
    }
  }
  if (variants.length === 0) throw new Error("That Lichess account has no rated games yet.");
  return { platform: "lichess", usernameDisplay: data.username, variants };
}

async function fetchChesscomProfile(username) {
  const uname = username.toLowerCase();
  const statsRes = await fetch(`https://api.chess.com/pub/player/${encodeURIComponent(uname)}/stats`);
  if (!statsRes.ok) throw new Error(statsRes.status === 404 ? "No Chess.com account with that username." : `Chess.com API error (${statsRes.status}).`);
  const stats = await statsRes.json();
  const map = [["chess_blitz", "blitz"], ["chess_rapid", "rapid"], ["chess_bullet", "bullet"], ["chess_daily", "daily"]];
  const variants = [];
  for (const [key, label] of map) {
    const block = stats[key];
    if (block && block.last && typeof block.last.rating === "number") {
      const rec = block.record || {};
      variants.push({ variant: label, rating: block.last.rating, games: (rec.win || 0) + (rec.loss || 0) + (rec.draw || 0) });
    }
  }
  if (variants.length === 0) throw new Error("That Chess.com account has no rated games yet.");
  let usernameDisplay = username;
  try {
    const profRes = await fetch(`https://api.chess.com/pub/player/${encodeURIComponent(uname)}`);
    if (profRes.ok) {
      const prof = await profRes.json();
      usernameDisplay = prof.username || username;
    }
  } catch {}
  return { platform: "chesscom", usernameDisplay, variants };
}

async function fetchRecentGames(platform, username, variant, maxGames = 10) {
  if (platform === "lichess") {
    const url = `https://lichess.org/api/games/user/${encodeURIComponent(username)}?max=${maxGames}&perfType=${variant}&moves=false&opening=false&clocks=false&evals=false&comments=false&tags=false&sort=dateDesc`;
    const res = await fetch(url, { headers: { Accept: "application/x-ndjson" } });
    if (!res.ok) throw new Error("Failed to fetch recent games from Lichess.");
    const text = await res.text();
    const games = text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    return games.map(g => ({
      id: g.id,
      pgn: null,
      white: g.players.white.user?.name || g.players.white.name || "?",
      black: g.players.black.user?.name || g.players.black.name || "?",
      result: g.winner ? (g.winner === "white" ? "1-0" : "0-1") : "½-½",
      date: new Date(g.createdAt).toLocaleDateString(),
    }));
  } else if (platform === "chesscom") {
    const uname = username.toLowerCase();
    const archivesRes = await fetch(`https://api.chess.com/pub/player/${uname}/games/archives`);
    if (!archivesRes.ok) throw new Error("Failed to fetch Chess.com archives.");
    const archives = await archivesRes.json();
    const archiveUrls = archives.archives || [];
    let collected = [];
    for (let i = archiveUrls.length - 1; i >= 0 && collected.length < maxGames; i--) {
      const res = await fetch(archiveUrls[i]);
      if (!res.ok) continue;
      const data = await res.json();
      const games = data.games || [];
      const variantMap = { bullet: "bullet", blitz: "blitz", rapid: "rapid", classical: "classical", daily: "daily" };
      const filtered = games.filter(g => g.time_class === variantMap[variant]);
      for (const g of filtered) {
        if (collected.length >= maxGames) break;
        collected.push({
          id: g.url,
          pgn: g.pgn,
          white: g.white.username,
          black: g.black.username,
          result: g.result,
          date: new Date(g.end_time * 1000).toLocaleDateString(),
        });
      }
    }
    return collected;
  }
  throw new Error("Unsupported platform for recent games.");
}

async function fetchGamePGN(platform, gameIdOrUrl, existingPgn) {
  if (existingPgn) return existingPgn;
  if (platform === "lichess") {
    const res = await fetch(`https://lichess.org/game/export/${gameIdOrUrl}`, { headers: { Accept: "application/x-chess-pgn" } });
    if (!res.ok) throw new Error("Couldn't fetch game PGN from Lichess.");
    return await res.text();
  } else if (platform === "chesscom") {
    throw new Error("PGN not available directly; please paste it manually.");
  }
  throw new Error("Unsupported platform.");
}

function pickPrimaryVariant(variants) {
  if (!variants || !variants.length) return null;
  return variants.slice().sort((a, b) => (b.games || 0) - (a.games || 0))[0];
}

/* ============================================================================
   SMALL UTILITIES
============================================================================ */

function timeAgo(ts) {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}
function platformLabel(p) { return p === "lichess" ? "Lichess" : "Chess.com"; }

/* ============================================================================
   PRESENTATIONAL PIECES
============================================================================ */

function RatingBadge({ rating, variant }) {
  const tier = ratingTier(rating);
  return (
    <span className="rating-badge">
      <span className="rating-dot" style={{ background: tier.color }} />
      <span className="rating-num">{rating}</span>
      {variant && <span className="rating-variant">{variant}</span>}
    </span>
  );
}

function PlatformTag({ platform }) {
  return <span className="platform-tag">{platformLabel(platform)}</span>;
}

function ChessBoard({ board, lastMove, flipped }) {
  const rows = flipped ? [...board].reverse().map((row) => [...row].reverse()) : board;
  return (
    <div className="board">
      {rows.map((row, ri) => {
        const realR = flipped ? 7 - ri : ri;
        return (
          <div className="board-row" key={ri}>
            {row.map((piece, ci) => {
              const realC = flipped ? 7 - ci : ci;
              const sq = rcToSq(realR, realC);
              const isLight = (realR + realC) % 2 === 0;
              const isLast = lastMove && (lastMove.from === sq || lastMove.to === sq);
              const glyph = piece ? (piece[0] === "w" ? WHITE_GLYPH[piece[1]] : BLACK_GLYPH[piece[1]]) : null;
              return (
                <div key={ci} className={"board-sq" + (isLight ? " light" : " dark") + (isLast ? " last-move" : "")}>
                  {piece && <span className={"piece " + (piece[0] === "w" ? "piece-w" : "piece-b")}>{glyph}</span>}
                  {ci === 0 && <span className="coord coord-rank">{8 - realR}</span>}
                  {realR === 7 && <span className="coord coord-file">{String.fromCharCode(97 + realC)}</span>}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function MoveNav({ ply, maxPly, onChange }) {
  return (
    <div className="move-nav">
      <button className="icon-btn" onClick={() => onChange(0)} disabled={ply === 0} aria-label="Start"><ChevronsLeft size={16} /></button>
      <button className="icon-btn" onClick={() => onChange(Math.max(0, ply - 1))} disabled={ply === 0} aria-label="Previous"><ChevronLeft size={16} /></button>
      <span className="move-nav-count">{ply} / {maxPly}</span>
      <button className="icon-btn" onClick={() => onChange(Math.min(maxPly, ply + 1))} disabled={ply === maxPly} aria-label="Next"><ChevronRight size={16} /></button>
      <button className="icon-btn" onClick={() => onChange(maxPly)} disabled={ply === maxPly} aria-label="End"><ChevronsRight size={16} /></button>
    </div>
  );
}

function MoveList({ moves, ply, onJump, annotations = [] }) {
  const pairs = [];
  for (let i = 0; i < moves.length; i += 2) {
    pairs.push({ num: moves[i].moveNumber, w: moves[i], b: moves[i + 1] || null, wi: i + 1, bi: i + 2 });
  }
  const annByPly = {};
  annotations.forEach(a => { annByPly[a.movePly] = a; });
  return (
    <div className="move-list">
      {pairs.map((p) => (
        <div className="move-list-row" key={p.num}>
          <span className="move-list-num">{p.num}.</span>
          <button className={"move-list-san" + (ply === p.wi ? " active" : "")} onClick={() => onJump(p.wi)}>
            {p.w.san}
            {annByPly[p.wi] && <span className="ann-dot" title={annByPly[p.wi].type === 'comment' ? 'Comment' : 'Variation'} />}
          </button>
          {p.b && (
            <button className={"move-list-san" + (ply === p.bi ? " active" : "")} onClick={() => onJump(p.bi)}>
              {p.b.san}
              {annByPly[p.bi] && <span className="ann-dot" title={annByPly[p.bi].type === 'comment' ? 'Comment' : 'Variation'} />}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function GapNotice({ icon, children }) {
  return (
    <div className="gap-notice">
      {icon}
      <span>{children}</span>
    </div>
  );
}

/* ============================================================================
   CONNECT SCREEN
============================================================================ */

function ConnectScreen({ onConnect, remembered }) {
  const [verifying, setVerifying] = useState(false);
  const [oauthError, setOauthError] = useState('');
  const [platform, setPlatform] = useState(remembered?.platform || "lichess");
  const [username, setUsername] = useState(remembered?.username || "");
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const [found, setFound] = useState(null);
  const [chosenVariant, setChosenVariant] = useState(null);
  const [manualRating, setManualRating] = useState("");
  const [manualLabel, setManualLabel] = useState("blitz");
  const startOAuth = async (platform) => {
  setVerifying(true);
  setOauthError('');
  try {
    const res = await fetch('/api/storage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'oauth_authorize', platform }),
    });
    const data = await res.json();
    if (!data.authUrl) throw new Error('No auth URL returned');
    // Open popup
    const width = 500, height = 600;
    const left = (window.screen.width - width) / 2;
    const top = (window.screen.height - height) / 2;
    const popup = window.open(data.authUrl, 'oauth', `width=${width},height=${height},left=${left},top=${top}`);
    // Poll for completion – we'll use message from callback
    window.addEventListener('message', async (event) => {
      if (event.origin !== window.location.origin) return;
      if (event.data.type === 'oauth_callback') {
        const { code, platform } = event.data;
        const verifyRes = await fetch('/api/storage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'oauth_callback', code, platform }),
        });
        const verifiedData = await verifyRes.json();
        if (!verifyRes.ok) throw new Error(verifiedData.error || 'Verification failed');
        // Merge verified data with found profile (ratings, etc.)
        const updatedFound = {
          ...found,
          usernameDisplay: verifiedData.usernameDisplay,
          variants: verifiedData.variants,
          verified: true,
        };
        setFound(updatedFound);
        const top = verifiedData.top || pickPrimaryVariant(verifiedData.variants);
        setChosenVariant(top);
        setVerifying(false);
        popup.close();
        // Optionally auto‑confirm
        }
      });
    } catch (e) {
      setOauthError(e.message);
      setVerifying(false);
    }
  };
  const lookup = async () => {
    if (!username.trim()) { setError("Enter a username first."); return; }
    setStatus("checking");
    setError("");
    try {
      const profile = platform === "lichess" ? await fetchLichessProfile(username.trim()) : await fetchChesscomProfile(username.trim());
      setFound(profile);
      const top = pickPrimaryVariant(profile.variants);
      setChosenVariant(top);
      setStatus("found");
      
    } catch (e) {
      setError(e.message || "Couldn't reach that platform right now.");
      setStatus("error");
    }
  };

  const confirmFound = () => {
    if (!found || !chosenVariant) return;
    onConnect({
      id: normalizeId(found.usernameDisplay),
      usernameDisplay: found.usernameDisplay,
      platform: found.platform,
      rating: chosenVariant.rating,
      ratingVariant: chosenVariant.variant,
      verified: true,
      platformProfileUrl: found.platform === "lichess" ? `https://lichess.org/@/${found.usernameDisplay}` : `https://www.chess.com/member/${found.usernameDisplay.toLowerCase()}`,
    });
  };

  const confirmManual = () => {
    const r = parseInt(manualRating, 10);
    if (!username.trim()) { setError("Enter a username first."); return; }
    if (!r || r < 100 || r > 3500) { setError("Enter a realistic rating (100–3500)."); return; }
    onConnect({
      id: normalizeId(username),
      usernameDisplay: username.trim(),
      platform,
      rating: r,
      ratingVariant: manualLabel,
      verified: false,
      platformProfileUrl: platform === "lichess" ? `https://lichess.org/@/${username.trim()}` : `https://www.chess.com/member/${username.trim().toLowerCase()}`,
    });
  };

  return (
    <div className="connect-wrap">
      <div className="connect-card">
        <div className="brand"><Swords size={22} /><span>Outpost</span></div>
        <h1>Get your games looked at by someone stronger.<br />Then do the same for someone behind you.</h1>
        <p className="connect-sub">
          Outpost pairs you with a review partner 300 rating points ahead, and lets you
          pay it forward to someone 300 points behind. Connect your account to see where you fit.
        </p>

        <div className="platform-toggle" role="group" aria-label="Choose platform">
          <button className={platform === "lichess" ? "active" : ""} onClick={() => { setPlatform("lichess"); setStatus("idle"); setFound(null); }}>Lichess</button>
          <button className={platform === "chesscom" ? "active" : ""} onClick={() => { setPlatform("chesscom"); setStatus("idle"); setFound(null); }}>Chess.com</button>
        </div>

        {status !== "manual" && (
          <div className="connect-form-row">
            <input
              type="text"
              value={username}
              placeholder={platform === "lichess" ? "Lichess username" : "Chess.com username"}
              onChange={(e) => { setUsername(e.target.value); setStatus("idle"); }}
              onKeyDown={(e) => { if (e.key === "Enter") lookup(); }}
            />
            <button className="btn-primary" onClick={lookup} disabled={status === "checking"}>
              {status === "checking" ? <Loader2 size={16} className="spin" /> : "Look up rating"}
            </button>
          </div>
        )}

        {status === "error" && (
          <div className="connect-error">
            <AlertCircle size={15} />
            <div>
              <div>{error}</div>
              <button className="link-btn" onClick={() => setStatus("manual")}>Enter my rating manually instead</button>
            </div>
          </div>
        )}

        {status === "found" && found && (
          <div className="connect-found">
            <div className="connect-found-name">Found <strong>{found.usernameDisplay}</strong> on {platformLabel(found.platform)}</div>
            <div className="variant-chips">
              {found.variants.map((v) => (
                <button
                  key={v.variant}
                  className={"variant-chip" + (chosenVariant?.variant === v.variant ? " active" : "")}
                  onClick={() => setChosenVariant(v)}
                >
                  <span className="variant-chip-label">{v.variant}</span>
                  <span className="variant-chip-rating">{v.rating}</span>
                </button>
                
              ))}
            </div>
            <p className="connect-found-hint">This rating decides who you can review and who reviews you. Pick the mode you play most.</p>
            <button className="btn-primary btn-block" onClick={confirmFound}>
              Enter Outpost as {found.usernameDisplay} ({chosenVariant?.rating})
            </button>
            <button 
              className="btn-secondary" 
              onClick={() => startOAuth(found.platform)}
              disabled={verifying}
            >
              {verifying ? <Loader2 size={16} className="spin" /> : 'Verify identity with ' + platformLabel(found.platform)}
            </button>
            {oauthError && <div className="connect-error"><AlertCircle size={15}/><span>{oauthError}</span></div>}
          </div>
        )}

        {status === "manual" && (
          <div className="connect-manual">
            <p className="connect-found-hint">
              Automatic lookup isn't reaching {platformLabel(platform)} from here. You can still join — your rating just
              won't be verified, and other players will see it marked as self-reported.
            </p>
            <div className="connect-form-row">
              <input type="text" value={username} placeholder="Your username" onChange={(e) => setUsername(e.target.value)} />
            </div>
            <div className="connect-form-row">
              <input type="number" value={manualRating} placeholder="Your rating" onChange={(e) => setManualRating(e.target.value)} />
              <select value={manualLabel} onChange={(e) => setManualLabel(e.target.value)}>
                <option value="bullet">Bullet</option>
                <option value="blitz">Blitz</option>
                <option value="rapid">Rapid</option>
                <option value="classical">Classical</option>
                <option value="daily">Daily</option>
              </select>
            </div>
            {error && <div className="connect-error"><AlertCircle size={15} /><span>{error}</span></div>}
            <button className="btn-primary btn-block" onClick={confirmManual}>Enter Outpost</button>
            <button className="link-btn" onClick={() => { setStatus("idle"); setError(""); }}>Try automatic lookup again</button>
          </div>
        )}
      </div>
      <p className="connect-footnote">
        Identity here is just the username you enter — Outpost doesn't use passwords. Anything you post
        (games, reviews, ratings) is visible to everyone else using this board.
      </p>
    </div>
  );
}

/* ============================================================================
   GAME ROW (list item) + REVIEW CARD
============================================================================ */

function GameRow({ game, reviewCount, onOpen, already, eligible, reasonLocked }) {
  const tier = ratingTier(game.posterRating);
  const actualCount = reviewCount ?? game.reviewCount ?? 0;
  return (
    <button className="game-row" onClick={() => onOpen(game.id)}>
      <span className="game-row-rating" style={{ color: tier.color }}>{game.posterRating}</span>
      <span className="game-row-main">
        <span className="game-row-title">
          {game.posterUsernameDisplay}
          <PlatformTag platform={game.posterPlatform} />
          {already && <span className="badge-mini reviewed">you reviewed this</span>}
          {!eligible && reasonLocked && <span className="badge-mini locked"><Lock size={10} />{reasonLocked}</span>}
        </span>
        <span className="game-row-question">{game.question || "No question added — general feedback wanted."}</span>
      </span>
      <span className="game-row-meta">
        <span className={"badge-count" + (actualCount >= MAX_REVIEWS ? " full" : "")}>{actualCount}/{MAX_REVIEWS}</span>
        <span className="game-row-time">{timeAgo(game.createdAt)}</span>
      </span>
    </button>
  );
}

function ReviewCard({ review, isOwn, isPoster, gameOpen, isResolvingReview, onUpvote, onEdit, onResolve, voted, onReport, currentUser, banStatus }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(review.text);
  const tier = ratingTier(review.reviewerRating);

  const save = () => {
    if (draft.trim().length < MIN_REVIEW_CHARS) return;
    onEdit(draft.trim());
    setEditing(false);
  };

  const hasAnnotations = review.annotations && review.annotations.length > 0;

  return (
    <div className={"review-card" + (isResolvingReview ? " resolved" : "")}>
      <div className="review-head">
        <span className="review-author">
          {review.reviewerUsernameDisplay}
          <PlatformTag platform={review.reviewerPlatform} />
        </span>
        <RatingBadge rating={review.reviewerRating} variant={review.reviewerRatingVariant} />
        <span className="review-time">{timeAgo(review.updatedAt || review.createdAt)}{review.updatedAt && review.updatedAt !== review.createdAt ? " · edited" : ""}</span>
        {!isOwn && currentUser && (
          <button className="report-btn" onClick={onReport} title="Report this review"><Flag size={12} /></button>
        )}
      </div>

      {isResolvingReview && <div className="resolved-flag"><CheckCircle2 size={14} /> Marked as the answer by the poster</div>}

      {editing ? (
        <div className="review-edit">
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} />
          <div className="review-edit-row">
            <span className={"char-count" + (draft.trim().length < MIN_REVIEW_CHARS ? " short" : "")}>{draft.trim().length}/{MIN_REVIEW_CHARS}+ characters</span>
            <div>
              <button className="link-btn" onClick={() => { setDraft(review.text); setEditing(false); }}>Cancel</button>
              <button className="btn-primary btn-sm" onClick={save} disabled={draft.trim().length < MIN_REVIEW_CHARS}>Save</button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <p className="review-text">{review.text}</p>
          {hasAnnotations && (
            <div className="review-annotations">
              <span className="ann-label"><BookOpen size={12} /> Annotations</span>
              <ul>
                {review.annotations.map((a, i) => (
                  <li key={i}>
                    <span className="ann-ply">Move {a.movePly}:</span>
                    {a.type === 'comment' ? (
                      <span className="ann-comment">{a.text}</span>
                    ) : (
                      <span className="ann-variation">
                        <span className="ann-variation-moves">{a.moves?.join(' ')}</span>
                        {a.text && <span className="ann-comment"> — {a.text}</span>}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      <div className="review-actions">
        <button className={"upvote-btn" + (voted ? " voted" : "")} onClick={onUpvote} disabled={isOwn}>
          <ThumbsUp size={13} /> {review.upvotedBy?.length || 0}
        </button>
        {isOwn && !editing && (
          <button className="link-btn" onClick={() => setEditing(true)}><Pencil size={12} /> Edit</button>
        )}
        {isPoster && gameOpen && !isResolvingReview && (
          <button className="link-btn resolve-btn" onClick={onResolve}><Check size={12} /> Mark as the answer</button>
        )}
      </div>
    </div>
  );
}

/* ============================================================================
   STUDY-COMPONENT FOR REVIEWING (add variations/comments)
============================================================================ */

function ReviewEditor({ parsed, initialPly, onSave }) {
  const [ply, setPly] = useState(initialPly);
  const [annotations, setAnnotations] = useState([]);
  const [commentInput, setCommentInput] = useState("");
  const [variationMoves, setVariationMoves] = useState([]);
  const [variationInput, setVariationInput] = useState("");
  const [showVariationInput, setShowVariationInput] = useState(false);

  const maxPly = parsed.positions.length - 1;

  const addComment = () => {
    if (!commentInput.trim()) return;
    const exists = annotations.find(a => a.movePly === ply && a.type === 'comment');
    if (exists) {
      setAnnotations(annotations.map(a => a.movePly === ply && a.type === 'comment' ? { ...a, text: commentInput.trim() } : a));
    } else {
      setAnnotations([...annotations, { movePly: ply, type: 'comment', text: commentInput.trim() }]);
    }
    setCommentInput("");
  };

  const addVariation = () => {
    if (variationMoves.length === 0) return;
    const exists = annotations.find(a => a.movePly === ply && a.type === 'variation');
    if (exists) {
      setAnnotations(annotations.map(a => a.movePly === ply && a.type === 'variation' ? { ...a, moves: variationMoves, text: commentInput.trim() } : a));
    } else {
      setAnnotations([...annotations, { movePly: ply, type: 'variation', moves: variationMoves, text: commentInput.trim() }]);
    }
    setVariationMoves([]);
    setVariationInput("");
    setShowVariationInput(false);
    setCommentInput("");
  };

  const handleVariationMoveAdd = () => {
    if (!variationInput.trim()) return;
    try {
      const board = cloneBoard(parsed.positions[ply]);
      const turn = (ply % 2 === 0) ? 'w' : 'b';
      applySAN(board, turn, variationInput.trim());
      setVariationMoves([...variationMoves, variationInput.trim()]);
      setVariationInput("");
    } catch {
      alert("Invalid move SAN.");
    }
  };

  return (
    <div className="review-editor">
      <div className="board-container">
        <ChessBoard board={parsed.positions[ply]} lastMove={ply > 0 ? parsed.moves[ply - 1] : null} />
        <MoveNav ply={ply} maxPly={maxPly} onChange={setPly} />
        <MoveList moves={parsed.moves} ply={ply} onJump={setPly} annotations={annotations} />
      </div>
      <div className="annotation-panel">
        <h4>Add annotation at move {ply}</h4>
        <div className="annotation-actions">
          <textarea value={commentInput} onChange={(e) => setCommentInput(e.target.value)} placeholder="Comment for this position..." rows={2} />
          <button className="btn-secondary" onClick={addComment} disabled={!commentInput.trim()}>
            <PlusCircle size={14} /> Add comment
          </button>
          <button className="btn-secondary" onClick={() => setShowVariationInput(!showVariationInput)}>
            <ChevronDown size={14} /> Variation
          </button>
          {showVariationInput && (
            <div className="variation-input-area">
              <input
                type="text"
                value={variationInput}
                onChange={(e) => setVariationInput(e.target.value)}
                placeholder="Enter SAN move (e.g., Nf3)"
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleVariationMoveAdd(); } }}
              />
              <button className="btn-secondary" onClick={handleVariationMoveAdd}>Add move</button>
              <button className="btn-primary btn-sm" onClick={addVariation} disabled={variationMoves.length === 0}>Save variation</button>
              {variationMoves.length > 0 && (
                <div className="variation-preview"><strong>Variation:</strong> {variationMoves.join(' ')}</div>
              )}
            </div>
          )}
        </div>
        {annotations.length > 0 && (
          <div className="existing-annotations">
            <strong>Current annotations:</strong>
            <ul>
              {annotations.map((a, i) => (
                <li key={i}>Move {a.movePly}: {a.type === 'comment' ? a.text : `Variation ${a.moves.join(' ')} ${a.text || ''}`}</li>
              ))}
            </ul>
          </div>
        )}
        <button className="btn-primary btn-block" onClick={() => onSave(annotations)} disabled={annotations.length === 0}>
          Save annotations
        </button>
      </div>
    </div>
  );
}

/* ============================================================================
   MAIN EXPORT
============================================================================ */

export default function OutpostApp() {
  const [initializing, setInitializing] = useState(true);
  const [currentUser, setCurrentUser] = useState(null);
  const [remembered, setRemembered] = useState(null);
  const [tab, setTab] = useState("queue");
  const [toast, setToast] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);

  // Replace the useEffect that reads session:

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Read from localStorage instead of storageGet
      const saved = localStorage.getItem('outpost_session');
      if (saved && !cancelled) {
        try {
          const user = JSON.parse(saved);
          // Optionally re-validate rating from API (but we trust stored data)
          setCurrentUser(user);
          setIsAdmin(user.usernameDisplay.toLowerCase() === "thiscreeper");
          // Store user profile in Redis (shared) for others to see
          await storageSet(userKey(user.id), {
            ...user,
            lastSeenAt: Date.now(),
            bannedUntil: null,
            bannedPermanently: false,
          }, true);
        } catch (e) { /* ignore */ }
      }
      if (!cancelled) setInitializing(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const handleConnect = useCallback(async (user) => {
    setCurrentUser(user);
    setIsAdmin(user.usernameDisplay.toLowerCase() === "thiscreeper");
    localStorage.setItem('outpost_session', JSON.stringify(user));
    await storageSet(userKey(user.id), {
      ...user,
      lastSeenAt: Date.now(),
      bannedUntil: null,
      bannedPermanently: false,
    }, true);
  }, []);

  const handleSwitchAccount = useCallback(() => {
    setCurrentUser(null);
    setIsAdmin(false);
    localStorage.removeItem('outpost_session');
  }, []);

  const showToast = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  }, []);

  if (initializing) {
    return (
      <div className="boot-screen"><Loader2 size={20} className="spin" /></div>
    );
  }

  if (!currentUser) {
    return (
      <div className="outpost-root">
        <GlobalStyle />
        <ConnectScreen onConnect={handleConnect} remembered={remembered} />
      </div>
    );
  }

  return (
    <div className="outpost-root">
      <GlobalStyle />
      <AppShell
        currentUser={currentUser}
        onSwitchAccount={handleSwitchAccount}
        tab={tab}
        setTab={setTab}
        showToast={showToast}
        isAdmin={isAdmin}
      />
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

/* ============================================================================
   APP SHELL
============================================================================ */

function AppShell({ currentUser, onSwitchAccount, tab, setTab, showToast, isAdmin }) {
  const [activeGameId, setActiveGameId] = useState(null);
  const [viewingProfileId, setViewingProfileId] = useState(null);

  const openGame = (id) => setActiveGameId(id);
  const closeGame = () => setActiveGameId(null);
  const openProfile = (id) => setViewingProfileId(id);
  const closeProfile = () => setViewingProfileId(null);

  return (
    <div className="shell">
      <header className="shell-header">
        <div className="brand"><Swords size={18} /><span>Outpost</span></div>
        <div className="identity">
          <span className="identity-name">{currentUser.usernameDisplay}</span>
          <PlatformTag platform={currentUser.platform} />
          <RatingBadge rating={currentUser.rating} variant={currentUser.ratingVariant} />
          {!currentUser.verified && <span className="badge-mini self-reported">self-reported</span>}
          {isAdmin && <span className="badge-mini admin"><Shield size={10} /> Admin</span>}
          <button className="icon-btn" onClick={onSwitchAccount} title="Switch account"><LogOut size={15} /></button>
        </div>
      </header>

      {!activeGameId && !viewingProfileId && (
        <nav className="tabs">
          <button className={tab === "queue" ? "active" : ""} onClick={() => setTab("queue")}>Review queue</button>
          <button className={tab === "mygames" ? "active" : ""} onClick={() => setTab("mygames")}>My games</button>
          <button className={tab === "submit" ? "active" : ""} onClick={() => setTab("submit")}>Submit a game</button>
          <button className={tab === "players" ? "active" : ""} onClick={() => setTab("players")}>Players</button>
          <button className={tab === "leaderboard" ? "active" : ""} onClick={() => setTab("leaderboard")}>Leaderboard</button>
          {isAdmin && <button className={tab === "admin" ? "active" : ""} onClick={() => setTab("admin")}>Admin</button>}
        </nav>
      )}

      <main className="content">
        {activeGameId ? (
          <GameDetail gameId={activeGameId} currentUser={currentUser} onBack={closeGame} showToast={showToast} />
        ) : viewingProfileId ? (
          <ProfileView userId={viewingProfileId} currentUser={currentUser} onBack={closeProfile} onOpenGame={openGame} />
        ) : tab === "queue" ? (
          <QueueView currentUser={currentUser} onOpen={openGame} />
        ) : tab === "mygames" ? (
          <MyGamesView currentUser={currentUser} onOpen={openGame} />
        ) : tab === "submit" ? (
          <SubmitView currentUser={currentUser} onSubmitted={(id) => { setTab("mygames"); showToast("Game posted for review."); }} />
        ) : tab === "players" ? (
          <PlayersView currentUser={currentUser} onOpenProfile={openProfile} />
        ) : tab === "leaderboard" ? (
          <LeaderboardView />
        ) : tab === "admin" && isAdmin ? (
          <AdminView currentUser={currentUser} showToast={showToast} />
        ) : (
          <LeaderboardView />
        )}
      </main>
    </div>
  );
}

/* ============================================================================
   QUEUE VIEW (optimized with bulkGet and stored reviewCount)
============================================================================ */

function QueueView({ currentUser, onOpen }) {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const keys = await storageList("games:", true);
      const games = (await storageBulkGet(keys, true)).filter(Boolean);
      const eligible = games.filter(
        (g) => g.status === "open" && g.posterId !== currentUser.id && currentUser.rating - g.posterRating >= REVIEW_GAP
      );
      eligible.sort((a, b) => b.createdAt - a.createdAt);

      // Check which of these eligible games the user has already reviewed
      const reviewKeysForUser = eligible.map(g => reviewKey(g.id, currentUser.id));
      const existingReviews = await storageBulkGet(reviewKeysForUser, true);
      const withAlready = eligible.map((g, i) => ({
        game: g,
        reviewCount: g.reviewCount || 0,
        already: !!existingReviews[i],
      }));

      setRows(withAlready.filter((r) => r.reviewCount < MAX_REVIEWS || r.already));
    } catch (e) {
      setError("Couldn't load the queue right now.");
    } finally {
      setLoading(false);
    }
  }, [currentUser]);

  useEffect(() => { load(); }, [load]);

  const minRatingNeeded = currentUser.rating - REVIEW_GAP;

  return (
    <div className="view">
      <ViewHeader
        title="Games waiting for a review"
        subtitle={`You can review players rated ${minRatingNeeded} or below (300 points under your ${currentUser.rating}).`}
      />
      {loading ? (
        <LoadingRows />
      ) : error ? (
        <EmptyState icon={<AlertCircle size={18} />} title="Something went wrong" body={error} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Search size={18} />}
          title="Nothing to review right now"
          body="When someone rated 300+ points below you posts a game, it'll show up here."
        />
      ) : (
        <div className="game-list">
          {rows.map(({ game, reviewCount, already }) => (
            <GameRow key={game.id} game={game} reviewCount={reviewCount} already={already} eligible onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ============================================================================
   MY GAMES VIEW (uses stored reviewCount)
============================================================================ */

function MyGamesView({ currentUser, onOpen }) {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const keys = await storageList("games:", true);
      const games = (await storageBulkGet(keys, true)).filter(Boolean);
      const mine = games.filter((g) => g.posterId === currentUser.id);
      mine.sort((a, b) => b.createdAt - a.createdAt);
      setRows(mine.map(g => ({ game: g, reviewCount: g.reviewCount || 0 })));
    } finally {
      setLoading(false);
    }
  }, [currentUser]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="view">
      <ViewHeader title="Your games" subtitle="Games you've posted, and how many reviews they've picked up." />
      {loading ? (
        <LoadingRows />
      ) : rows.length === 0 ? (
        <EmptyState icon={<Plus size={18} />} title="No games posted yet" body="Submit a game and someone stronger will take a look." />
      ) : (
        <div className="game-list">
          {rows.map(({ game, reviewCount }) => (
            <GameRow key={game.id} game={game} reviewCount={reviewCount} eligible onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ============================================================================
   SUBMIT VIEW — recent games import, no manual PGN by default
============================================================================ */

function SubmitView({ currentUser, onSubmitted }) {
  const [selectedGame, setSelectedGame] = useState(null);
  const [variant, setVariant] = useState("blitz");
  const [recentGames, setRecentGames] = useState([]);
  const [loadingGames, setLoadingGames] = useState(false);
  const [importError, setImportError] = useState("");
  const [question, setQuestion] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  const fetchGames = async () => {
    setLoadingGames(true);
    setImportError("");
    setSelectedGame(null);
    try {
      const games = await fetchRecentGames(currentUser.platform, currentUser.usernameDisplay, variant, 10);
      setRecentGames(games);
    } catch (e) {
      setImportError(e.message || "Couldn't load recent games.");
    } finally {
      setLoadingGames(false);
    }
  };

  useEffect(() => {
    fetchGames();
  }, [variant]);

  const selectGame = async (game) => {
    setSelectedGame(game);
    if (!game.pgn) {
      try {
        const pgn = await fetchGamePGN(currentUser.platform, game.id, null);
        setSelectedGame({ ...game, pgn });
      } catch (e) {
        setImportError("Couldn't load PGN for that game. You may paste it below.");
      }
    }
  };

  const submit = async () => {
    if (!selectedGame) { setSubmitError("Select a game first."); return; }
    if (!selectedGame.pgn) { setSubmitError("PGN missing for selected game."); return; }
    setSubmitting(true);
    setSubmitError("");
    try {
      const id = newGameId();
      await storageSet(gameKey(id), {
        id,
        pgn: selectedGame.pgn.trim(),
        question: question.trim(),
        posterId: currentUser.id,
        posterUsernameDisplay: currentUser.usernameDisplay,
        posterPlatform: currentUser.platform,
        posterRating: currentUser.rating,
        posterRatingVariant: currentUser.ratingVariant,
        status: "open",
        createdAt: Date.now(),
        resolvedReviewerId: null,
        resolvedAt: null,
        reviewCount: 0,
        sourceGameId: selectedGame.id,
        sourcePlatform: currentUser.platform,
      }, true);

      // Update user's gameCount
      const user = await storageGet(userKey(currentUser.id), true);
      if (user) {
        await storageSet(userKey(currentUser.id), { ...user, gameCount: (user.gameCount || 0) + 1, lastSeenAt: Date.now() }, true);
      } else {
        await storageSet(userKey(currentUser.id), {
          id: currentUser.id,
          usernameDisplay: currentUser.usernameDisplay,
          platform: currentUser.platform,
          rating: currentUser.rating,
          ratingVariant: currentUser.ratingVariant,
          verified: currentUser.verified,
          platformProfileUrl: currentUser.platformProfileUrl,
          lastSeenAt: Date.now(),
          gameCount: 1,
          reviewCount: 0,
          bannedUntil: null,
          bannedPermanently: false,
        }, true);
      }

      setSelectedGame(null);
      setQuestion("");
      onSubmitted(id);
    } catch (e) {
      setSubmitError("Couldn't post that game — try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="view">
      <ViewHeader title="Submit a game" subtitle="Choose one of your recent games and ask for feedback. Your opponent's name will be visible, so be respectful." />

      <div className="submit-grid">
        <div className="submit-col">
          <label className="field-label">Select variant</label>
          <select value={variant} onChange={(e) => setVariant(e.target.value)} className="full-width">
            <option value="blitz">Blitz</option>
            <option value="bullet">Bullet</option>
            <option value="rapid">Rapid</option>
            <option value="classical">Classical</option>
          </select>
          <button className="btn-secondary" onClick={fetchGames} disabled={loadingGames}>
            {loadingGames ? <Loader2 size={15} className="spin" /> : "Refresh games"}
          </button>
          {importError && <div className="connect-error"><AlertCircle size={14} /><span>{importError}</span></div>}

          <label className="field-label">Recent {variant} games</label>
          {loadingGames ? (
            <div className="loading-rows"><Loader2 size={18} className="spin" /></div>
          ) : recentGames.length === 0 ? (
            <EmptyState icon={<Swords size={16} />} title="No recent games" body="You haven't played any games in this variant recently." compact />
          ) : (
            <div className="game-picker">
              {recentGames.map((g) => (
                <button
                  key={g.id}
                  className={"game-picker-item" + (selectedGame?.id === g.id ? " selected" : "")}
                  onClick={() => selectGame(g)}
                >
                  <span className="gpi-players">{g.white} vs {g.black}</span>
                  <span className="gpi-result">{g.result}</span>
                  <span className="gpi-date">{g.date}</span>
                </button>
              ))}
            </div>
          )}

          {selectedGame && (
            <>
              <label className="field-label">What do you want feedback on?</label>
              <textarea
                className="question-input"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                rows={3}
                placeholder="e.g. I felt fine out of the opening but lost the thread around move 20 — where did it go wrong?"
              />
              {submitError && <div className="connect-error"><AlertCircle size={14} /><span>{submitError}</span></div>}
              <button className="btn-primary btn-block" onClick={submit} disabled={submitting || !selectedGame?.pgn}>
                {submitting ? <Loader2 size={15} className="spin" /> : "Post for review"}
              </button>
            </>
          )}
        </div>

        <div className="submit-col preview-col">
          <label className="field-label">Preview</label>
          {selectedGame?.pgn ? (
            <GamePreview pgn={selectedGame.pgn} />
          ) : (
            <EmptyState icon={<Swords size={16} />} title="Board preview" body="Select a game to see it here." compact />
          )}
        </div>
      </div>
    </div>
  );
}

function GamePreview({ pgn }) {
  const parsed = useMemo(() => {
    try { return replayPGN(pgn); } catch { return null; }
  }, [pgn]);
  const [ply, setPly] = useState(parsed ? parsed.positions.length - 1 : 0);
  useEffect(() => { if (parsed) setPly(parsed.positions.length - 1); }, [parsed]);

  if (!parsed || parsed.moves.length === 0) return <p className="parse-warning">Could not parse PGN.</p>;
  return (
    <>
      <ChessBoard board={parsed.positions[ply]} lastMove={ply > 0 ? parsed.moves[ply - 1] : null} />
      <MoveNav ply={ply} maxPly={parsed.positions.length - 1} onChange={setPly} />
      <MoveList moves={parsed.moves} ply={ply} onJump={setPly} />
    </>
  );
}

/* ============================================================================
   GAME DETAIL — with annotations and report
============================================================================ */

function GameDetail({ gameId, currentUser, onBack, showToast }) {
  const [loading, setLoading] = useState(true);
  const [game, setGame] = useState(null);
  const [reviews, setReviews] = useState([]);
  const [ply, setPly] = useState(0);
  const [reviewDraft, setReviewDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState("");
  const [showReviewEditor, setShowReviewEditor] = useState(false);
  const [savedAnnotations, setSavedAnnotations] = useState([]);
  const [reporting, setReporting] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const g = await storageGet(gameKey(gameId), true);
    setGame(g);
    if (g) {
      const reviewKeys = await storageList(reviewPrefix(gameId), true);
      const list = (await storageBulkGet(reviewKeys, true)).filter(Boolean);
      list.sort((a, b) => a.createdAt - b.createdAt);
      setReviews(list);
    }
    setLoading(false);
  }, [gameId]);

  useEffect(() => { load(); }, [load]);

  const parsed = useMemo(() => {
    if (!game) return null;
    try { return replayPGN(game.pgn); } catch { return null; }
  }, [game]);

  useEffect(() => { if (parsed) setPly(parsed.positions.length - 1); }, [parsed?.moves?.length]);

  if (loading) return <LoadingRows />;
  if (!game) return <EmptyState icon={<AlertCircle size={18} />} title="Game not found" body="It may have been removed." />;

  const isPoster = game.posterId === currentUser.id;
  const myReview = reviews.find((r) => r.reviewerId === currentUser.id);
  const gapOk = currentUser.rating - game.posterRating >= REVIEW_GAP;
  const canReviewNew = !isPoster && gapOk && game.status === "open" && !myReview && reviews.length < MAX_REVIEWS;

  const postReview = async () => {
    const text = reviewDraft.trim();
    if (text.length < MIN_REVIEW_CHARS) { setPostError(`Reviews need at least ${MIN_REVIEW_CHARS} characters.`); return; }
    setPosting(true);
    setPostError("");
    try {
      const now = Date.now();
      const existing = myReview;
      await storageSet(reviewKey(gameId, currentUser.id), {
        gameId,
        reviewerId: currentUser.id,
        reviewerUsernameDisplay: currentUser.usernameDisplay,
        reviewerPlatform: currentUser.platform,
        reviewerRating: currentUser.rating,
        reviewerRatingVariant: currentUser.ratingVariant,
        text,
        annotations: savedAnnotations,
        createdAt: existing ? existing.createdAt : now,
        updatedAt: now,
        upvotedBy: existing ? existing.upvotedBy || [] : [],
      }, true);

      // If new review, increment game.reviewCount
      if (!existing) {
        await storageSet(gameKey(gameId), { ...game, reviewCount: (game.reviewCount || 0) + 1 }, true);
        // Update reviewer's reviewCount
        const reviewerUser = await storageGet(userKey(currentUser.id), true);
        if (reviewerUser) {
          await storageSet(userKey(currentUser.id), { ...reviewerUser, reviewCount: (reviewerUser.reviewCount || 0) + 1, lastSeenAt: Date.now() }, true);
        }
      }

      setReviewDraft("");
      setSavedAnnotations([]);
      setShowReviewEditor(false);
      showToast("Review posted.");
      await load();
    } catch {
      setPostError("Couldn't post that review — try again.");
    } finally {
      setPosting(false);
    }
  };

  const editReview = async (reviewerId, newText, newAnnotations) => {
    const r = reviews.find((rv) => rv.reviewerId === reviewerId);
    if (!r) return;
    await storageSet(reviewKey(gameId, reviewerId), {
      ...r,
      text: newText || r.text,
      annotations: newAnnotations || r.annotations,
      updatedAt: Date.now()
    }, true);
    showToast("Review updated.");
    load();
  };

  const toggleUpvote = async (r) => {
    if (r.reviewerId === currentUser.id) return;
    const voted = (r.upvotedBy || []).includes(currentUser.id);
    const upvotedBy = voted ? r.upvotedBy.filter((u) => u !== currentUser.id) : [...(r.upvotedBy || []), currentUser.id];
    await storageSet(reviewKey(gameId, r.reviewerId), { ...r, upvotedBy }, true);
    load();
  };

  const resolveWith = async (reviewerId) => {
    await storageSet(gameKey(gameId), { ...game, status: "resolved", resolvedReviewerId: reviewerId, resolvedAt: Date.now() }, true);
    showToast("Marked as resolved. Thanks for closing the loop.");
    load();
  };

  const reportReview = async (review) => {
    setReporting({ type: 'review', id: review.reviewerId });
    try {
      const reportId = newReportId();
      await storageSet(reportKey(reportId), {
        id: reportId,
        targetType: 'review',
        targetId: review.reviewerId,
        gameId: gameId,
        reporterId: currentUser.id,
        reporterUsername: currentUser.usernameDisplay,
        createdAt: Date.now(),
        status: 'open',
        note: '',
      }, true);
      showToast("Review reported. An admin will review it.");
    } catch {
      showToast("Failed to report review.");
    } finally {
      setReporting(null);
    }
  };

  const reportGame = async () => {
    setReporting({ type: 'game', id: gameId });
    try {
      const reportId = newReportId();
      await storageSet(reportKey(reportId), {
        id: reportId,
        targetType: 'game',
        targetId: gameId,
        gameId: gameId,
        reporterId: currentUser.id,
        reporterUsername: currentUser.usernameDisplay,
        createdAt: Date.now(),
        status: 'open',
        note: '',
      }, true);
      showToast("Game reported. An admin will review it.");
    } catch {
      showToast("Failed to report game.");
    } finally {
      setReporting(null);
    }
  };

  return (
    <div className="view">
      <button className="back-link" onClick={onBack}><ArrowLeft size={14} /> Back</button>

      <div className="detail-grid">
        <div className="detail-col">
          <div className="detail-poster">
            <span className="game-row-title">
              {game.posterUsernameDisplay}
              <PlatformTag platform={game.posterPlatform} />
              <a href={currentUser.platformProfileUrl} target="_blank" rel="noopener noreferrer" className="profile-link"><ExternalLink size={12} /> Profile</a>
            </span>
            <RatingBadge rating={game.posterRating} variant={game.posterRatingVariant} />
            <span className={"status-tag " + game.status}>{game.status === "open" ? "Open" : "Resolved"}</span>
            {!isPoster && (
              <button className="report-btn" onClick={reportGame} title="Report this game"><Flag size={12} /></button>
            )}
          </div>

          {parsed && parsed.moves.length > 0 ? (
            <>
              <ChessBoard board={parsed.positions[ply]} lastMove={ply > 0 ? parsed.moves[ply - 1] : null} />
              <MoveNav ply={ply} maxPly={parsed.positions.length - 1} onChange={setPly} />
              <MoveList moves={parsed.moves} ply={ply} onJump={setPly} />
            </>
          ) : (
            <div className="pgn-raw"><pre>{game.pgn}</pre></div>
          )}
        </div>

        <div className="detail-col">
          {game.question && (
            <div className="question-block">
              <span className="field-label">What they're asking</span>
              <p>{game.question}</p>
            </div>
          )}

          <div className="reviews-block">
            <span className="field-label">{reviews.length} of {MAX_REVIEWS} reviews</span>

            {reviews.length === 0 && <EmptyState icon={<Sparkles size={16} />} title="No reviews yet" body="Be the first to weigh in." compact />}

            {reviews.map((r) => (
              <ReviewCard
                key={r.reviewerId}
                review={r}
                isOwn={r.reviewerId === currentUser.id}
                isPoster={isPoster}
                gameOpen={game.status === "open"}
                isResolvingReview={game.resolvedReviewerId === r.reviewerId}
                voted={(r.upvotedBy || []).includes(currentUser.id)}
                onUpvote={() => toggleUpvote(r)}
                onEdit={(text, anns) => editReview(r.reviewerId, text, anns)}
                onResolve={() => resolveWith(r.reviewerId)}
                onReport={() => reportReview(r)}
                currentUser={currentUser}
              />
            ))}

            {isPoster && (
              <GapNotice icon={<Info size={14} />}>
                This is your game — reviews stay open until you mark one as the answer, even after others weigh in.
              </GapNotice>
            )}

            {!isPoster && !gapOk && (
              <GapNotice icon={<Lock size={14} />}>
                You need to be rated {game.posterRating + REVIEW_GAP}+ to review this game. You're at {currentUser.rating}.
              </GapNotice>
            )}

            {!isPoster && gapOk && game.status !== "open" && (
              <GapNotice icon={<CheckCircle2 size={14} />}>This question has been marked resolved by the poster.</GapNotice>
            )}

            {!isPoster && gapOk && game.status === "open" && reviews.length >= MAX_REVIEWS && !myReview && (
              <GapNotice icon={<Info size={14} />}>This game already has the maximum of {MAX_REVIEWS} reviews.</GapNotice>
            )}

            {myReview && !canReviewNew && (
              <p className="parse-warning"><Info size={13} /> You already reviewed this game — edit your review above any time.</p>
            )}

            {canReviewNew && !showReviewEditor && (
              <div className="review-form">
                <span className="field-label">Your review</span>
                <textarea
                  value={reviewDraft}
                  onChange={(e) => setReviewDraft(e.target.value)}
                  rows={5}
                  placeholder="What would you tell them about this game? Be specific — a move number or a plan beats general praise."
                />
                <div className="review-edit-row">
                  <span className={"char-count" + (reviewDraft.trim().length < MIN_REVIEW_CHARS ? " short" : "")}>
                    {reviewDraft.trim().length}/{MIN_REVIEW_CHARS}+ characters
                  </span>
                  {postError && <span className="inline-error">{postError}</span>}
                  <div className="btn-group">
                    <button className="btn-secondary" onClick={() => setShowReviewEditor(true)} disabled={reviewDraft.trim().length < MIN_REVIEW_CHARS}>
                      <BookOpen size={13} /> Add annotations
                    </button>
                    <button className="btn-primary btn-sm" onClick={postReview} disabled={posting || reviewDraft.trim().length < MIN_REVIEW_CHARS}>
                      {posting ? <Loader2 size={14} className="spin" /> : <><Send size={13} /> Post review</>}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {canReviewNew && showReviewEditor && (
              <div className="review-editor-container">
                <span className="field-label">Add annotations (comments & variations)</span>
                <ReviewEditor
                  parsed={parsed}
                  initialPly={ply}
                  onSave={(anns) => { setSavedAnnotations(anns); setShowReviewEditor(false); }}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================================
   PLAYERS VIEW (uses stored user counts)
============================================================================ */

function PlayersView({ currentUser, onOpenProfile }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const keys = await storageList("users:", true);
      const userList = (await storageBulkGet(keys, true)).filter(Boolean);
      if (!cancelled) {
        setUsers(userList.sort((a,b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0)));
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) return <LoadingRows />;

  return (
    <div className="view">
      <ViewHeader title="Players" subtitle="Everyone who has connected to Outpost. Click to see their games and reviews." />
      <div className="players-grid">
        {users.map((u) => (
          <div className="player-card" key={u.id} onClick={() => onOpenProfile(u.id)}>
            <div className="player-card-header">
              <span className="player-name">{u.usernameDisplay}</span>
              <PlatformTag platform={u.platform} />
              {u.bannedPermanently || (u.bannedUntil && u.bannedUntil > Date.now()) ? (
                <span className="badge-mini banned"><Ban size={10} /> Banned</span>
              ) : null}
            </div>
            <RatingBadge rating={u.rating} variant={u.ratingVariant} />
            <div className="player-stats">
              <span>{u.gameCount || 0} games</span>
              <span>{u.reviewCount || 0} reviews</span>
            </div>
            {u.platformProfileUrl && (
              <a href={u.platformProfileUrl} target="_blank" rel="noopener noreferrer" className="player-profile-link">
                <ExternalLink size={12} /> View on {platformLabel(u.platform)}
              </a>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============================================================================
   PROFILE VIEW
============================================================================ */

function ProfileView({ userId, currentUser, onBack, onOpenGame }) {
  const [user, setUser] = useState(null);
  const [games, setGames] = useState([]);
  const [reviews, setReviews] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const u = await storageGet(userKey(userId), true);
      setUser(u);
      if (u) {
        const gameKeys = await storageList("games:", true);
        const allGames = (await storageBulkGet(gameKeys, true)).filter(Boolean);
        const userGames = allGames.filter(g => g.posterId === userId);
        setGames(userGames);
        const reviewKeys = await storageList("reviews:", true);
        const allReviews = (await storageBulkGet(reviewKeys, true)).filter(Boolean);
        const userReviews = allReviews.filter(r => r.reviewerId === userId);
        setReviews(userReviews);
      }
      setLoading(false);
    })();
  }, [userId]);

  if (loading) return <LoadingRows />;
  if (!user) return <EmptyState icon={<AlertCircle size={18} />} title="User not found" body="They may have never connected." />;

  const isBanned = user.bannedPermanently || (user.bannedUntil && user.bannedUntil > Date.now());

  return (
    <div className="view">
      <button className="back-link" onClick={onBack}><ArrowLeft size={14} /> Back</button>
      <div className="profile-header">
        <h2>{user.usernameDisplay}</h2>
        <PlatformTag platform={user.platform} />
        <RatingBadge rating={user.rating} variant={user.ratingVariant} />
        {user.verified ? <span className="badge-mini verified"><CheckCircle2 size={12} /> verified</span> : <span className="badge-mini self-reported">self-reported</span>}
        {isBanned && <span className="badge-mini banned"><Ban size={12} /> Banned</span>}
        <a href={user.platformProfileUrl} target="_blank" rel="noopener noreferrer" className="profile-link">
          <ExternalLink size={14} /> {platformLabel(user.platform)} profile
        </a>
      </div>

      <div className="profile-sections">
        <section>
          <h3>Submitted games ({games.length})</h3>
          {games.length === 0 ? <EmptyState icon={<Swords size={16} />} title="No games" body="This user hasn't submitted any games yet." compact /> : (
            <div className="game-list">
              {games.map(g => (
                <GameRow key={g.id} game={g} reviewCount={g.reviewCount || 0} eligible onOpen={onOpenGame} />
              ))}
            </div>
          )}
        </section>
        <section>
          <h3>Reviews written ({reviews.length})</h3>
          {reviews.length === 0 ? <EmptyState icon={<Sparkles size={16} />} title="No reviews" body="This user hasn't written any reviews yet." compact /> : (
            <div className="review-list-simple">
              {reviews.map(r => (
                <div key={r.gameId} className="review-summary">
                  <span className="review-summary-text">{r.text.substring(0, 100)}...</span>
                  <span className="review-summary-meta">on game {r.gameId}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/* ============================================================================
   LEADERBOARD (uses bulkGet, no per-key fetches)
============================================================================ */

function LeaderboardView() {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const reviewKeys = await storageList("reviews:", true);
      const gameKeys = await storageList("games:", true);
      const [allReviews, allGames] = await Promise.all([
        storageBulkGet(reviewKeys, true),
        storageBulkGet(gameKeys, true),
      ]);
      const reviews = allReviews.filter(Boolean);
      const games = allGames.filter(Boolean);
      const resolvedCounts = {};
      for (const g of games) {
        if (g.resolvedReviewerId) resolvedCounts[g.resolvedReviewerId] = (resolvedCounts[g.resolvedReviewerId] || 0) + 1;
      }
      const byUser = {};
      for (const r of reviews) {
        const key = r.reviewerId;
        if (!byUser[key]) {
          byUser[key] = {
            id: key,
            usernameDisplay: r.reviewerUsernameDisplay,
            platform: r.reviewerPlatform,
            rating: r.reviewerRating,
            reviewsGiven: 0,
            upvotes: 0,
          };
        }
        byUser[key].reviewsGiven += 1;
        byUser[key].upvotes += (r.upvotedBy || []).length;
      }
      const list = Object.values(byUser).map((u) => {
        const resolved = resolvedCounts[u.id] || 0;
        const score = u.reviewsGiven * 1 + u.upvotes * 3 + resolved * 10;
        return { ...u, resolved, score };
      });
      list.sort((a, b) => b.score - a.score);
      if (!cancelled) {
        setRows(list.slice(0, 20));
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="view">
      <ViewHeader title="Top seconds" subtitle="Ranked by reviews given, upvotes from other players, and games marked resolved." />
      {loading ? (
        <LoadingRows />
      ) : rows.length === 0 ? (
        <EmptyState icon={<Trophy size={18} />} title="No reviews yet" body="The leaderboard fills in as people start reviewing games." />
      ) : (
        <div className="leaderboard-list">
          {rows.map((u, i) => (
            <div className="leaderboard-row" key={u.id}>
              <span className={"lb-rank" + (i < 3 ? " top" : "")}>
                {i === 0 ? <Trophy size={15} /> : i < 3 ? <Medal size={15} /> : i + 1}
              </span>
              <span className="lb-name">
                {u.usernameDisplay}
                <PlatformTag platform={u.platform} />
                <span className="lb-tier">{secondTier(u.score)}</span>
              </span>
              <span className="lb-stats">
                {u.reviewsGiven} reviews · {u.upvotes} upvotes · {u.resolved} resolved
              </span>
              <span className="lb-score">{u.score}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ============================================================================
   ADMIN VIEW
============================================================================ */

function AdminView({ currentUser, showToast }) {
  const [reports, setReports] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const reportKeys = await storageList("reports:", true);
      const reportList = (await storageBulkGet(reportKeys, true)).filter(Boolean);
      reportList.sort((a,b) => b.createdAt - a.createdAt);
      setReports(reportList);
      const userKeys = await storageList("users:", true);
      const userList = (await storageBulkGet(userKeys, true)).filter(Boolean);
      setUsers(userList);
      setLoading(false);
    })();
  }, []);

  const banUser = async (userId, permanent = false, durationDays = 7) => {
    const user = users.find(u => u.id === userId);
    if (!user) return;
    const bannedUntil = permanent ? null : Date.now() + durationDays * 86400000;
    await storageSet(userKey(userId), {
      ...user,
      bannedPermanently: permanent,
      bannedUntil: bannedUntil,
    }, true);
    showToast(`User ${user.usernameDisplay} ${permanent ? 'permanently banned' : `banned for ${durationDays} days`}.`);
    setUsers(users.map(u => u.id === userId ? { ...u, bannedPermanently: permanent, bannedUntil } : u));
  };

  const unbanUser = async (userId) => {
    const user = users.find(u => u.id === userId);
    if (!user) return;
    await storageSet(userKey(userId), {
      ...user,
      bannedPermanently: false,
      bannedUntil: null,
    }, true);
    showToast(`User ${user.usernameDisplay} unbanned.`);
    setUsers(users.map(u => u.id === userId ? { ...u, bannedPermanently: false, bannedUntil: null } : u));
  };

  const closeReport = async (reportId) => {
    const report = reports.find(r => r.id === reportId);
    if (!report) return;
    await storageSet(reportKey(reportId), { ...report, status: 'closed' }, true);
    setReports(reports.map(r => r.id === reportId ? { ...r, status: 'closed' } : r));
    showToast("Report marked as handled.");
  };

  if (loading) return <LoadingRows />;

  return (
    <div className="view admin-view">
      <ViewHeader title="Admin Panel" subtitle="Handle reports and manage user bans." />
      <section>
        <h3>Open reports ({reports.filter(r => r.status === 'open').length})</h3>
        <div className="reports-list">
          {reports.filter(r => r.status === 'open').map(r => (
            <div key={r.id} className="report-item">
              <div className="report-info">
                <span className="report-type">{r.targetType === 'review' ? 'Review' : 'Game'}</span>
                <span>Reported by {r.reporterUsername}</span>
                <span className="report-time">{timeAgo(r.createdAt)}</span>
                {r.targetType === 'review' ? (
                  <span>Reviewer ID: {r.targetId}</span>
                ) : (
                  <span>Game ID: {r.targetId}</span>
                )}
                {r.note && <span className="report-note">{r.note}</span>}
              </div>
              <div className="report-actions">
                <button className="link-btn" onClick={() => closeReport(r.id)}>Mark handled</button>
              </div>
            </div>
          ))}
          {reports.filter(r => r.status === 'open').length === 0 && (
            <EmptyState icon={<CheckCircle2 size={18} />} title="No open reports" body="Nothing to handle right now." compact />
          )}
        </div>
      </section>

      <section>
        <h3>User management</h3>
        <div className="user-management-list">
          {users.map(u => (
            <div key={u.id} className="user-management-row">
              <span className="user-name">{u.usernameDisplay}</span>
              <span className="user-id">({u.id})</span>
              {u.bannedPermanently || (u.bannedUntil && u.bannedUntil > Date.now()) ? (
                <span className="badge-mini banned"><Ban size={10} /> Banned</span>
              ) : (
                <span className="badge-mini active">Active</span>
              )}
              <div className="user-actions">
                {!u.bannedPermanently && (!u.bannedUntil || u.bannedUntil <= Date.now()) ? (
                  <>
                    <button className="link-btn" onClick={() => banUser(u.id, false, 7)}>Ban 7d</button>
                    <button className="link-btn" onClick={() => banUser(u.id, false, 30)}>Ban 30d</button>
                    <button className="link-btn" onClick={() => banUser(u.id, true)}>Ban permanently</button>
                  </>
                ) : (
                  <button className="link-btn" onClick={() => unbanUser(u.id)}>Unban</button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/* ============================================================================
   SHARED SMALL VIEWS
============================================================================ */

function ViewHeader({ title, subtitle }) {
  return (
    <div className="view-header">
      <h2>{title}</h2>
      {subtitle && <p>{subtitle}</p>}
    </div>
  );
}
function EmptyState({ icon, title, body, compact }) {
  return (
    <div className={"empty-state" + (compact ? " compact" : "")}>
      {icon}
      <strong>{title}</strong>
      <span>{body}</span>
    </div>
  );
}
function LoadingRows() {
  return (
    <div className="loading-rows">
      <Loader2 size={18} className="spin" />
    </div>
  );
}

/* ============================================================================
   STYLE
============================================================================ */

function GlobalStyle() {
  return (
    <style>{`
      .outpost-root {
        --ink: #1B1F1C;
        --ink-soft: #454F49;
        --paper: #F3EFE2;
        --paper-dim: #E9E2D0;
        --moss: #4C7A5D;
        --moss-deep: #34523F;
        --gold: #C79A4B;
        --rust: #A34E36;
        --charcoal: #262B27;
        --stone: #8B8578;
        --serif: 'Iowan Old Style', 'Palatino Linotype', Georgia, 'Times New Roman', serif;
        --mono: ui-monospace, 'SF Mono', 'Cascadia Mono', Consolas, 'Liberation Mono', monospace;
        --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        background: var(--ink);
        min-height: 100vh;
        color: var(--charcoal);
        font-family: var(--sans);
        -webkit-font-smoothing: antialiased;
      }
      .outpost-root * { box-sizing: border-box; }
      .outpost-root button { font-family: inherit; cursor: pointer; }
      .outpost-root input, .outpost-root textarea, .outpost-root select { font-family: inherit; }

      .boot-screen { min-height: 100vh; display:flex; align-items:center; justify-content:center; background: var(--ink); color: var(--paper); }
      .spin { animation: spin 0.9s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }

      /* ---------- connect screen ---------- */
      .connect-wrap { min-height: 100vh; display:flex; flex-direction:column; align-items:center; justify-content:center; padding: 32px 20px; gap: 18px; }
      .connect-card { background: var(--paper); border-radius: 4px; padding: 36px 34px; max-width: 460px; width: 100%; }
      .brand { display:flex; align-items:center; gap: 8px; color: var(--moss); font-family: var(--mono); font-size: 14px; letter-spacing: 0.02em; margin-bottom: 22px; }
      .connect-card h1 { font-family: var(--serif); font-size: 26px; line-height: 1.3; font-weight: 600; margin: 0 0 12px; color: var(--charcoal); }
      .connect-sub { font-size: 14px; line-height: 1.55; color: var(--ink-soft); margin: 0 0 22px; max-width: 62ch; }
      .connect-footnote { color: var(--stone); font-size: 12.5px; max-width: 460px; text-align: center; line-height: 1.5; }

      .platform-toggle { display:flex; border: 1px solid var(--stone); border-radius: 3px; overflow:hidden; margin-bottom: 14px; width: fit-content; }
      .platform-toggle button { padding: 7px 16px; background: transparent; border: none; font-size: 13px; color: var(--ink-soft); }
      .platform-toggle button.active { background: var(--moss); color: var(--paper); }

      .connect-form-row { display:flex; gap: 8px; margin-bottom: 10px; }
      .connect-form-row input, .connect-form-row select { flex:1; padding: 10px 12px; border: 1px solid var(--stone); border-radius: 3px; font-size: 14px; background: #fff; }
      .connect-form-row input:focus, .connect-form-row select:focus { outline: 2px solid var(--moss); outline-offset: 1px; }

      .btn-primary { background: var(--moss); color: var(--paper); border: none; padding: 10px 18px; border-radius: 3px; font-size: 14px; font-weight: 600; white-space: nowrap; display:inline-flex; align-items:center; gap:6px; justify-content:center; }
      .btn-primary:hover:not(:disabled) { background: var(--moss-deep); }
      .btn-primary:disabled { opacity: 0.55; cursor: default; }
      .btn-primary.btn-block { width: 100%; margin-top: 6px; }
      .btn-primary.btn-sm { padding: 6px 12px; font-size: 12.5px; }
      .btn-secondary { background: transparent; border: 1px solid var(--moss); color: var(--moss); padding: 10px 16px; border-radius: 3px; font-size: 13px; }
      .btn-secondary:hover { background: rgba(76,122,93,0.08); }
      .btn-group { display:flex; gap: 8px; align-items:center; }

      .link-btn { background: none; border: none; color: var(--moss-deep); text-decoration: underline; font-size: 12.5px; padding: 0; margin-right: 10px; }

      .connect-error { display:flex; gap:8px; align-items:flex-start; background: rgba(163,78,54,0.08); border: 1px solid rgba(163,78,54,0.3); color: var(--rust); padding: 10px 12px; border-radius: 3px; font-size: 13px; margin-bottom: 10px; }
      .connect-error > div:first-child, .connect-error svg { flex-shrink: 0; margin-top: 1px; }

      .connect-found { border-top: 1px solid var(--paper-dim); padding-top: 16px; margin-top: 4px; }
      .connect-found-name { font-size: 13.5px; color: var(--ink-soft); margin-bottom: 10px; }
      .connect-found-hint { font-size: 12.5px; color: var(--stone); margin: 8px 0 12px; }
      .variant-chips { display:flex; flex-wrap:wrap; gap: 8px; }
      .variant-chip { display:flex; flex-direction:column; align-items:center; gap:2px; border: 1px solid var(--stone); background: #fff; padding: 7px 14px; border-radius: 3px; }
      .variant-chip-label { font-family: var(--mono); font-size: 10.5px; text-transform: capitalize; color: var(--stone); }
      .variant-chip-rating { font-family: var(--mono); font-weight: 700; font-size: 15px; color: var(--charcoal); }
      .variant-chip.active { border-color: var(--moss); background: rgba(76,122,93,0.08); }
      .variant-chip.active .variant-chip-rating { color: var(--moss-deep); }

      /* ---------- badges ---------- */
      .rating-badge { display:inline-flex; align-items:center; gap: 5px; font-family: var(--mono); font-size: 12.5px; }
      .rating-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink:0; }
      .rating-num { font-weight: 700; }
      .rating-variant { color: var(--stone); text-transform: capitalize; }
      .platform-tag { font-family: var(--mono); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.03em; color: var(--stone); border: 1px solid var(--stone); border-radius: 2px; padding: 1px 5px; }
      .badge-mini { font-family: var(--mono); font-size: 10.5px; padding: 1px 6px; border-radius: 2px; display:inline-flex; align-items:center; gap:3px; }
      .badge-mini.reviewed { background: rgba(76,122,93,0.12); color: var(--moss-deep); }
      .badge-mini.locked { background: rgba(163,78,54,0.1); color: var(--rust); }
      .badge-mini.self-reported { background: rgba(199,154,75,0.15); color: #8a6a2e; }
      .badge-mini.admin { background: rgba(76,122,93,0.2); color: var(--moss-deep); }
      .badge-mini.verified { background: rgba(76,122,93,0.15); color: var(--moss-deep); }
      .badge-mini.banned { background: rgba(163,78,54,0.15); color: var(--rust); }

      /* ---------- shell ---------- */
      .shell { min-height: 100vh; display:flex; flex-direction:column; }
      .shell-header { background: var(--ink); color: var(--paper); padding: 14px 24px; display:flex; align-items:center; justify-content:space-between; flex-wrap: wrap; gap: 10px; }
      .shell-header .brand { margin: 0; color: var(--gold); }
      .identity { display:flex; align-items:center; gap: 10px; font-size: 13px; flex-wrap: wrap; }
      .identity-name { font-weight: 600; }
      .identity .rating-badge { color: var(--paper); }
      .identity .rating-variant { color: #b9b3a2; }
      .identity .platform-tag { color: #b9b3a2; border-color: #555f58; }
      .identity .icon-btn { color: var(--paper); }

      .tabs { display:flex; gap: 4px; background: var(--ink); padding: 0 20px; overflow-x: auto; }
      .tabs button { background: none; border: none; color: #b9b3a2; padding: 12px 14px; font-size: 13.5px; border-bottom: 2px solid transparent; white-space: nowrap; }
      .tabs button.active { color: var(--paper); border-bottom-color: var(--gold); }

      .content { flex: 1; background: var(--paper); padding: 26px 24px 60px; }

      .icon-btn { background: none; border: none; padding: 4px; border-radius: 3px; display:inline-flex; color: var(--ink-soft); }
      .icon-btn:hover:not(:disabled) { background: rgba(0,0,0,0.06); }
      .icon-btn:disabled { opacity: 0.3; }

      .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: var(--ink); color: var(--paper); padding: 10px 18px; border-radius: 3px; font-size: 13px; box-shadow: 0 6px 18px rgba(0,0,0,0.25); z-index: 100; }

      /* ---------- view scaffolding ---------- */
      .view { max-width: 980px; margin: 0 auto; }
      .view-header { margin-bottom: 20px; }
      .view-header h2 { font-family: var(--serif); font-size: 22px; margin: 0 0 4px; }
      .view-header p { font-size: 13.5px; color: var(--ink-soft); margin: 0; max-width: 68ch; }

      .loading-rows { display:flex; justify-content:center; padding: 50px 0; color: var(--stone); }
      .empty-state { display:flex; flex-direction:column; align-items:center; gap:6px; text-align:center; padding: 46px 20px; color: var(--stone); border: 1px dashed var(--stone); border-radius: 4px; }
      .empty-state.compact { padding: 22px 16px; }
      .empty-state strong { color: var(--charcoal); font-size: 14px; }
      .empty-state span { font-size: 13px; max-width: 40ch; }

      /* ---------- game list ---------- */
      .game-list { border-top: 1px solid var(--paper-dim); }
      .game-row { width: 100%; display:flex; align-items:center; gap: 16px; background: none; border: none; border-bottom: 1px solid var(--paper-dim); padding: 14px 6px; text-align: left; }
      .game-row:hover { background: rgba(76,122,93,0.05); }
      .game-row-rating { font-family: var(--mono); font-weight: 700; font-size: 15px; width: 46px; flex-shrink: 0; }
      .game-row-main { flex: 1; min-width: 0; display:flex; flex-direction:column; gap: 3px; }
      .game-row-title { display:flex; align-items:center; gap: 8px; font-weight: 600; font-size: 14px; flex-wrap:wrap; }
      .game-row-question { font-family: var(--serif); font-style: italic; color: var(--ink-soft); font-size: 13.5px; white-space: nowrap; overflow:hidden; text-overflow: ellipsis; }
      .game-row-meta { display:flex; flex-direction:column; align-items:flex-end; gap: 4px; flex-shrink:0; }
      .badge-count { font-family: var(--mono); font-size: 11.5px; color: var(--stone); }
      .badge-count.full { color: var(--rust); }
      .game-row-time { font-family: var(--mono); font-size: 11px; color: var(--stone); }

      /* ---------- submit view ---------- */
      .submit-grid { display:grid; grid-template-columns: 1.1fr 0.9fr; gap: 30px; }
      .field-label { display:block; font-family: var(--mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--stone); margin: 16px 0 6px; }
      .field-label:first-child { margin-top: 0; }
      .full-width { width: 100%; padding: 8px 12px; border: 1px solid var(--stone); border-radius: 3px; font-size: 14px; background: #fff; }
      .pgn-input { width:100%; padding: 12px; border: 1px solid var(--stone); border-radius: 3px; font-family: var(--mono); font-size: 13px; resize: vertical; background: #fff; }
      .question-input { width:100%; padding: 12px; border: 1px solid var(--stone); border-radius: 3px; font-family: var(--serif); font-size: 14px; resize: vertical; background: #fff; }
      .preview-col { background: var(--paper-dim); border-radius: 4px; padding: 16px; }
      .parse-warning { display:flex; gap:6px; align-items:flex-start; font-size: 12px; color: var(--stone); margin-top: 10px; }

      .game-picker { display:flex; flex-direction:column; gap: 8px; max-height: 300px; overflow-y:auto; }
      .game-picker-item { display:flex; justify-content:space-between; align-items:center; padding: 10px 14px; background: #fff; border: 1px solid var(--paper-dim); border-radius: 3px; cursor:pointer; text-align:left; }
      .game-picker-item:hover { border-color: var(--moss); }
      .game-picker-item.selected { border-color: var(--moss); background: rgba(76,122,93,0.05); }
      .gpi-players { font-weight:600; font-size:13px; }
      .gpi-result { font-family: var(--mono); font-size:12px; color: var(--stone); }
      .gpi-date { font-family: var(--mono); font-size:11px; color: var(--stone); }

      /* ---------- board ---------- */
      .board { display:flex; flex-direction:column; width: 100%; max-width: 420px; aspect-ratio: 1; border: 1px solid var(--charcoal); }
      .board-row { display:flex; flex: 1; }
      .board-sq { position:relative; flex:1; display:flex; align-items:center; justify-content:center; }
      .board-sq.light { background: var(--paper); }
      .board-sq.dark { background: var(--moss); }
      .board-sq.last-move::after { content:''; position:absolute; inset:0; background: rgba(199,154,75,0.35); }
      .piece { position:relative; z-index:1; font-size: min(7.5vw, 34px); line-height: 1; user-select:none; }
      .piece-b { color: var(--charcoal); text-shadow: 0 0 0 var(--charcoal); }
      .piece-w { color: #fbf8f0; text-shadow: -1px 0 var(--charcoal), 0 1px var(--charcoal), 1px 0 var(--charcoal), 0 -1px var(--charcoal); }
      .coord { position:absolute; font-family: var(--mono); font-size: 9px; opacity: 0.65; z-index:1; }
      .coord-rank { top: 2px; left: 3px; }
      .coord-file { bottom: 1px; right: 3px; }
      .board-sq.light .coord { color: var(--moss-deep); }
      .board-sq.dark .coord { color: var(--paper); }

      .move-nav { display:flex; align-items:center; gap: 4px; margin-top: 10px; }
      .move-nav-count { font-family: var(--mono); font-size: 12px; color: var(--stone); margin: 0 8px; }
      .move-list { display:flex; flex-direction:column; gap: 2px; margin-top: 12px; max-height: 220px; overflow-y:auto; border-top: 1px solid var(--paper-dim); padding-top: 8px; }
      .move-list-row { display:flex; align-items:center; gap: 8px; font-family: var(--mono); font-size: 13px; }
      .move-list-num { color: var(--stone); width: 26px; flex-shrink:0; }
      .move-list-san { background:none; border:none; padding: 2px 6px; border-radius: 2px; color: var(--charcoal); position:relative; }
      .move-list-san.active { background: var(--moss); color: var(--paper); }
      .ann-dot { position:absolute; top:2px; right:2px; width: 6px; height:6px; border-radius:50%; background: var(--gold); }
      .pgn-raw { background: var(--paper-dim); border-radius: 4px; padding: 14px; max-height: 300px; overflow:auto; }
      .pgn-raw pre { font-family: var(--mono); font-size: 12px; white-space: pre-wrap; margin:0; }

      /* ---------- detail ---------- */
      .back-link { display:inline-flex; align-items:center; gap:6px; background:none; border:none; color: var(--moss-deep); font-size: 13px; margin-bottom: 16px; padding: 0; }
      .detail-grid { display:grid; grid-template-columns: 1.05fr 0.95fr; gap: 34px; }
      .detail-poster { display:flex; align-items:center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
      .status-tag { font-family: var(--mono); font-size: 10.5px; text-transform: uppercase; padding: 2px 7px; border-radius: 2px; }
      .status-tag.open { background: rgba(76,122,93,0.15); color: var(--moss-deep); }
      .status-tag.resolved { background: rgba(199,154,75,0.2); color: #8a6a2e; }
      .question-block { margin-bottom: 20px; }
      .question-block p { font-family: var(--serif); font-size: 15px; line-height: 1.5; margin: 0; }
      .reviews-block .field-label { margin-top: 0; }

      .review-card { border: 1px solid var(--paper-dim); border-radius: 4px; padding: 14px 16px; margin-bottom: 12px; background: #fff; position:relative; }
      .review-card.resolved { border-color: var(--gold); background: rgba(199,154,75,0.06); }
      .review-head { display:flex; align-items:center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
      .review-author { display:flex; align-items:center; gap:7px; font-weight:600; font-size: 13.5px; }
      .review-time { margin-left: auto; font-family: var(--mono); font-size: 11px; color: var(--stone); }
      .resolved-flag { display:flex; align-items:center; gap:6px; font-size: 12px; color: #8a6a2e; margin-bottom: 8px; }
      .review-text { font-size: 14px; line-height: 1.55; margin: 0 0 10px; white-space: pre-wrap; }
      .review-annotations { margin: 8px 0; font-size: 13px; }
      .ann-label { display:flex; align-items:center; gap:4px; font-weight:600; color: var(--moss-deep); margin-bottom:4px; }
      .review-annotations ul { list-style:none; padding-left: 0; margin: 4px 0; }
      .review-annotations li { margin-bottom: 4px; }
      .ann-ply { font-family: var(--mono); font-size: 11px; color: var(--stone); margin-right: 4px; }
      .ann-comment { color: var(--charcoal); }
      .ann-variation-moves { font-family: var(--mono); background: var(--paper-dim); padding: 1px 4px; border-radius: 2px; }

      .review-actions { display:flex; align-items:center; gap: 4px; }
      .upvote-btn { display:flex; align-items:center; gap:5px; background:none; border: 1px solid var(--stone); border-radius: 12px; padding: 3px 10px; font-size: 12px; color: var(--ink-soft); margin-right: auto; }
      .upvote-btn.voted { border-color: var(--moss); color: var(--moss-deep); background: rgba(76,122,93,0.08); }
      .upvote-btn:disabled { opacity: 0.5; cursor: default; }
      .resolve-btn { color: var(--moss-deep); }

      .report-btn { background:none; border:none; color: var(--stone); cursor:pointer; padding: 2px 4px; margin-left:auto; }
      .report-btn:hover { color: var(--rust); }

      .review-edit textarea { width:100%; padding: 10px; border: 1px solid var(--stone); border-radius: 3px; font-size: 14px; font-family: inherit; }
      .review-edit-row { display:flex; align-items:center; justify-content:space-between; margin-top: 8px; gap: 8px; flex-wrap: wrap; }
      .char-count { font-family: var(--mono); font-size: 11px; color: var(--stone); }
      .char-count.short { color: var(--rust); }
      .inline-error { font-size: 12px; color: var(--rust); }

      .review-form { border-top: 1px solid var(--paper-dim); padding-top: 14px; margin-top: 8px; }
      .review-form textarea { width:100%; padding: 12px; border: 1px solid var(--stone); border-radius: 3px; font-size: 14px; font-family: inherit; resize: vertical; }

      .review-editor-container { margin-top: 12px; }
      .review-editor { display:flex; gap: 20px; }
      .board-container { flex:1; }
      .annotation-panel { flex:1; display:flex; flex-direction:column; gap:10px; }
      .annotation-actions textarea { width:100%; padding:8px; }
      .variation-input-area { display:flex; flex-direction:column; gap:6px; margin-top:4px; }
      .variation-input-area input { padding:6px; }
      .variation-preview { font-family: var(--mono); font-size:12px; }

      .gap-notice { display:flex; gap:8px; align-items:flex-start; font-size: 12.5px; color: var(--stone); background: var(--paper-dim); border-radius: 3px; padding: 10px 12px; margin-top: 10px; }

      /* ---------- players ---------- */
      .players-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; }
      .player-card { background: #fff; border: 1px solid var(--paper-dim); border-radius: 4px; padding: 16px; cursor:pointer; transition: border-color 0.2s; }
      .player-card:hover { border-color: var(--moss); }
      .player-card-header { display:flex; align-items:center; gap: 8px; margin-bottom: 8px; }
      .player-name { font-weight:600; font-size: 14px; }
      .player-stats { display:flex; gap: 12px; margin: 8px 0; font-size: 12.5px; color: var(--ink-soft); }
      .player-profile-link { display:inline-flex; align-items:center; gap:4px; font-size: 12px; color: var(--moss-deep); }

      /* ---------- profile view ---------- */
      .profile-header { display:flex; align-items:center; gap: 10px; flex-wrap: wrap; margin-bottom: 24px; }
      .profile-link { display:inline-flex; align-items:center; gap:4px; font-size: 12px; color: var(--moss-deep); }
      .profile-sections section { margin-bottom: 30px; }
      .review-summary { padding: 8px 0; border-bottom: 1px solid var(--paper-dim); }

      /* ---------- leaderboard ---------- */
      .leaderboard-list { border-top: 1px solid var(--paper-dim); }
      .leaderboard-row { display:flex; align-items:center; gap: 16px; padding: 12px 6px; border-bottom: 1px solid var(--paper-dim); }
      .lb-rank { width: 26px; font-family: var(--mono); font-weight: 700; color: var(--stone); display:flex; align-items:center; }
      .lb-rank.top { color: var(--gold); }
      .lb-name { flex:1; display:flex; align-items:center; gap: 8px; font-weight: 600; font-size: 13.5px; flex-wrap: wrap; }
      .lb-tier { font-family: var(--mono); font-size: 10.5px; color: var(--stone); font-weight: 400; }
      .lb-stats { font-family: var(--mono); font-size: 11.5px; color: var(--stone); }
      .lb-score { font-family: var(--mono); font-weight: 700; font-size: 15px; color: var(--moss-deep); width: 40px; text-align: right; }

      /* ---------- admin ---------- */
      .admin-view section { margin-bottom: 30px; }
      .reports-list { display:flex; flex-direction:column; gap: 8px; }
      .report-item { background: #fff; border: 1px solid var(--paper-dim); border-radius: 4px; padding: 12px; display:flex; justify-content:space-between; align-items:center; }
      .report-info { display:flex; flex-wrap:wrap; gap: 8px; align-items:center; font-size: 13px; }
      .report-type { font-weight:600; text-transform: uppercase; font-size: 11px; color: var(--moss-deep); }
      .report-time { font-family: var(--mono); font-size: 11px; color: var(--stone); }
      .user-management-list { display:flex; flex-direction:column; gap: 8px; }
      .user-management-row { background: #fff; border: 1px solid var(--paper-dim); border-radius: 4px; padding: 12px; display:flex; align-items:center; gap: 12px; flex-wrap: wrap; }
      .user-name { font-weight:600; }
      .user-id { font-family: var(--mono); font-size: 11px; color: var(--stone); }
      .user-actions { display:flex; gap: 6px; margin-left:auto; }

      @media (max-width: 760px) {
        .submit-grid, .detail-grid, .review-editor { grid-template-columns: 1fr; flex-direction: column; }
        .content { padding: 20px 14px 50px; }
        .shell-header { padding: 12px 16px; }
        .game-row { flex-wrap: wrap; }
        .game-row-meta { flex-direction: row; align-items:center; }
      }
    `}</style>
  );
}