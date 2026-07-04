import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import axios from "axios";
import Hls from "hls.js";
import { Zap, Radio, Trophy, WifiOff } from "lucide-react";

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;

// Kick uses Pusher (public creds — visible in kick.com bundle)
const PUSHER_APP_KEY = "32cbd69e4b950bf97679";
const PUSHER_CLUSTER = "us2";

const PHASE = {
  WAKING: "waking",
  VOTING: "voting",
  REVEALING: "revealing",
  PLAYING: "playing",
  ERROR: "error",
};

// ---- Tiny Web Audio sound engine (no external files, no bandwidth) ----
let _ac = null;
const getAc = () => {
  if (!_ac) {
    try { _ac = new (window.AudioContext || window.webkitAudioContext)(); }
    catch { _ac = null; }
  }
  return _ac;
};
const beep = (freq, dur = 0.15, type = "sine", gain = 0.15, when = 0) => {
  const ac = getAc();
  if (!ac) return;
  const t = ac.currentTime + when;
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(ac.destination);
  o.start(t); o.stop(t + dur + 0.02);
};
const SFX = {
  tick: () => beep(1200, 0.05, "square", 0.06),
  whoosh: () => { beep(180, 0.25, "sawtooth", 0.08); beep(320, 0.2, "sine", 0.05, 0.05); },
  win: () => { beep(523, 0.12, "triangle", 0.18); beep(659, 0.12, "triangle", 0.18, 0.12); beep(880, 0.28, "triangle", 0.2, 0.24); },
};

function useQuery() {
  return useMemo(() => {
    const p = new URLSearchParams(window.location.search);
    return {
      channel: (p.get("channel") || "").trim(),
      duration: Math.max(3, parseInt(p.get("duration") || "8", 10)),
      chat: (p.get("chat") || "on").toLowerCase() !== "off",
    };
  }, []);
}

export default function ClipVoter() {
  const { channel, duration, chat: chatEnabled } = useQuery();
  const [phase, setPhase] = useState(PHASE.WAKING);
  const [errorMsg, setErrorMsg] = useState("");
  const [clips, setClips] = useState([]);
  const [votes, setVotes] = useState({ 1: 0, 2: 0, 3: 0 });
  const [remaining, setRemaining] = useState(duration);
  const [winnerIdx, setWinnerIdx] = useState(null);
  const [videoProgress, setVideoProgress] = useState(0);
  const [chatStatus, setChatStatus] = useState("connecting");
  const [chatFeed, setChatFeed] = useState([]);

  const votersRef = useRef(new Set()); // unique voter ids per round
  const votesRef = useRef({ 1: 0, 2: 0, 3: 0 });
  const wsRef = useRef(null);
  const chatroomIdRef = useRef(null);
  const videoRef = useRef(null);
  const timerRef = useRef(null);

  // ---- Reset round state ----
  const resetRound = useCallback(() => {
    votersRef.current = new Set();
    votesRef.current = { 1: 0, 2: 0, 3: 0 };
    setVotes({ 1: 0, 2: 0, 3: 0 });
    setClips([]);
    setWinnerIdx(null);
    setRemaining(duration);
    setVideoProgress(0);
    setChatFeed([]);
  }, [duration]);

  // ---- Fetch channel meta + clips ----
  const startNewRound = useCallback(async () => {
    if (!channel) {
      setErrorMsg("URL'e ?channel=kullanici_adi ekleyin.");
      setPhase(PHASE.ERROR);
      return;
    }
    resetRound();
    setPhase(PHASE.WAKING);
    try {
      const [chRes, clipRes] = await Promise.all([
        axios.get(`${API}/kick/channel/${channel}`),
        axios.get(`${API}/kick/clips/${channel}`, { params: { count: 3 } }),
      ]);
      chatroomIdRef.current = chRes.data.chatroom_id;
      const list = clipRes.data.clips || [];
      if (list.length < 1) throw new Error("Klip bulunamadı");
      // pad to 3 if channel has fewer
      while (list.length < 3) list.push({ ...list[0], id: `dup-${list.length}` });
      setClips(list.slice(0, 3));
      setPhase(PHASE.VOTING);
      setRemaining(duration);
    } catch (e) {
      const detail = e?.response?.data?.detail || e?.message || "Bilinmeyen hata";
      setErrorMsg(`Kick'ten veri alınamadı: ${detail}`);
      setPhase(PHASE.ERROR);
      // auto retry after 6s
      setTimeout(() => startNewRound(), 6000);
    }
  }, [channel, duration, resetRound]);

  // ---- Pusher WebSocket for Kick chat ----
  useEffect(() => {
    if (phase !== PHASE.VOTING) return;
    const chatroomId = chatroomIdRef.current;
    if (!chatroomId) return;

    const url = `wss://ws-${PUSHER_CLUSTER}.pusher.com/app/${PUSHER_APP_KEY}?protocol=7&client=js&version=8.4.0&flash=false`;
    const ws = new WebSocket(url);
    wsRef.current = ws;
    setChatStatus("connecting");

    ws.onopen = () => {
      ws.send(JSON.stringify({
        event: "pusher:subscribe",
        data: { auth: "", channel: `chatrooms.${chatroomId}.v2` },
      }));
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.event === "pusher:connection_established") setChatStatus("connected");
        if (msg.event === "pusher_internal:subscription_succeeded") setChatStatus("connected");
        if (msg.event === "App\\Events\\ChatMessageEvent") {
          const payload = typeof msg.data === "string" ? JSON.parse(msg.data) : msg.data;
          const text = (payload?.content || "").trim();
          const userId = payload?.sender?.id || payload?.sender?.username;
          const username = payload?.sender?.username || "user";
          const color = payload?.sender?.identity?.color || "#ffffff";
          if (!userId || !text) return;
          // add to feed (last 12)
          setChatFeed(prev => [...prev.slice(-11), { id: `${Date.now()}-${Math.random()}`, username, text, color }]);
          const m = text.match(/^([123])\s*$/);
          if (!m) return;
          if (votersRef.current.has(userId)) return;
          votersRef.current.add(userId);
          const n = parseInt(m[1], 10);
          votesRef.current = { ...votesRef.current, [n]: (votesRef.current[n] || 0) + 1 };
          setVotes({ ...votesRef.current });
        }
      } catch { /* ignore malformed frames */ }
    };

    ws.onerror = () => setChatStatus("error");
    ws.onclose = () => setChatStatus("disconnected");

    return () => {
      try { ws.close(); } catch { /* noop */ }
      wsRef.current = null;
    };
  }, [phase]);

  // ---- Countdown timer ----
  useEffect(() => {
    if (phase !== PHASE.VOTING) return;
    setRemaining(duration);
    SFX.whoosh();
    const start = Date.now();
    let lastTickSec = -1;
    timerRef.current = setInterval(() => {
      const passed = (Date.now() - start) / 1000;
      const left = Math.max(0, duration - passed);
      setRemaining(left);
      // tick sound in final 3 seconds
      const sec = Math.ceil(left);
      if (sec <= 3 && sec > 0 && sec !== lastTickSec) {
        lastTickSec = sec;
        SFX.tick();
      }
      if (left <= 0) {
        clearInterval(timerRef.current);
        const v = votesRef.current;
        let best = 1;
        if (v[2] > v[best]) best = 2;
        if (v[3] > v[best]) best = 3;
        const allZero = v[1] === 0 && v[2] === 0 && v[3] === 0;
        const winner = allZero ? (1 + Math.floor(Math.random() * 3)) : best;
        setWinnerIdx(winner);
        setPhase(PHASE.REVEALING);
        SFX.win();
        // 2s dramatic reveal → play
        setTimeout(() => setPhase(PHASE.PLAYING), 2200);
      }
    }, 100);
    return () => clearInterval(timerRef.current);
  }, [phase, duration]);

  // ---- Video progress + auto-loop when video ends ----
  useEffect(() => {
    if (phase !== PHASE.PLAYING) return;
    const v = videoRef.current;
    if (!v) return;

    const src = clips[winnerIdx - 1]?.video_url;
    if (!src) return;

    let hls = null;
    // Kick clips are HLS (.m3u8). Native support on Safari; hls.js elsewhere (OBS/Chromium).
    const isHls = src.includes(".m3u8");
    if (isHls && !v.canPlayType("application/vnd.apple.mpegurl") && Hls.isSupported()) {
      hls = new Hls({ enableWorker: true, lowLatencyMode: false });
      hls.loadSource(src);
      hls.attachMedia(v);
    } else {
      v.src = src;
    }

    v.currentTime = 0;
    // Try unmuted autoplay; if browser blocks (OBS BrowserSource allows via flags),
    // fall back to muted so playback still proceeds.
    v.muted = false;
    v.play().catch(() => {
      v.muted = true;
      v.play().catch(() => { /* noop */ });
    });

    const onTime = () => {
      if (v.duration > 0 && isFinite(v.duration)) {
        setVideoProgress((v.currentTime / v.duration) * 100);
      }
    };
    const onEnded = () => startNewRound();

    v.addEventListener("timeupdate", onTime);
    v.addEventListener("ended", onEnded);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("ended", onEnded);
      if (hls) { try { hls.destroy(); } catch { /* noop */ } }
    };
  }, [phase, winnerIdx, clips, startNewRound]);

  // ---- Kickoff on mount ----
  useEffect(() => {
    startNewRound();
    return () => {
      clearInterval(timerRef.current);
    };
  }, [startNewRound]);

  const totalVotes = (votes[1] || 0) + (votes[2] || 0) + (votes[3] || 0);
  const timeRatio = Math.max(0, Math.min(1, remaining / duration));

  const formatDate = (iso) => {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      return d.toLocaleString("tr-TR", {
        day: "2-digit", month: "short", year: "numeric",
        hour: "2-digit", minute: "2-digit",
      });
    } catch { return ""; }
  };

  return (
    <div data-testid="clip-voter-root" className="relative w-screen h-screen overflow-hidden text-white">
      <div className="bg-stage" />
      <div className="grain" />

      {/* HEADER (small, in-corner) */}
      <div className="absolute top-5 left-6 z-40 flex items-center gap-3">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/10 bg-black/40 backdrop-blur-md">
          <span className="inline-block w-2 h-2 rounded-full bg-[#00ff9d] shadow-[0_0_10px_#00ff9d] animate-pulse" />
          <span className="text-xs tracking-[0.28em] uppercase text-white/80">Kick Klip Turnuvası</span>
        </div>
        {channel && (
          <div data-testid="channel-badge" className="px-3 py-1.5 rounded-full border border-[#b445ff]/40 bg-[#b445ff]/10 text-xs tracking-widest uppercase mono">
            /{channel}
          </div>
        )}
      </div>

      <div className="absolute top-5 right-6 z-40 flex items-center gap-2 text-xs">
        {chatStatus === "connected" ? (
          <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-[#00ff9d]/40 bg-black/40 text-[#00ff9d]">
            <Radio size={13} /> CHAT LIVE
          </span>
        ) : (
          <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-white/10 bg-black/40 text-white/60">
            <WifiOff size={13} /> {chatStatus.toUpperCase()}
          </span>
        )}
      </div>

      {/* ---------- WAKING ---------- */}
      {phase === PHASE.WAKING && (
        <div data-testid="waking-screen" className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-8">
          <div className="loader" />
          <div className="text-2xl md:text-3xl tracking-[0.42em] uppercase neon-pulse text-[#00ff9d]">
            Yeni tur hazırlanıyor
          </div>
          <div className="text-xs tracking-[0.35em] uppercase text-white/40 mono">
            {channel ? `kick.com/${channel}` : "channel parametresi bekleniyor"}
          </div>
        </div>
      )}

      {/* ---------- ERROR ---------- */}
      {phase === PHASE.ERROR && (
        <div data-testid="error-screen" className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-6 px-8 text-center">
          <div className="text-xs tracking-[0.4em] uppercase text-[#ff5577]">Bağlantı Hatası</div>
          <div className="text-lg text-white/80 max-w-xl">{errorMsg}</div>
          <div className="text-xs text-white/40 mono">Otomatik olarak yeniden denenecek...</div>
        </div>
      )}

      {/* ---------- VOTING ---------- */}
      {phase === PHASE.VOTING && clips.length === 3 && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center px-8 gap-8 fade-in">

          {/* Top title */}
          <div className="text-center">
            <div className="text-4xl md:text-5xl font-extrabold tracking-tight neon-pulse" style={{ color: "#00ff9d", textShadow: "0 0 24px rgba(0,255,157,0.55)" }}>
              Yayın birazdan düzelecek
            </div>
            <div className="mt-2 text-[11px] tracking-[0.45em] uppercase text-white/45">
              Kazanan klip birazdan oynatılacak
            </div>
          </div>

          {/* Countdown + prompt */}
          <div className="flex items-center gap-6 px-8 py-5 rounded-2xl border border-white/10 bg-black/50 backdrop-blur-md">
            <div className="flex flex-col items-center leading-none">
              <span data-testid="countdown-text" className="mono text-6xl font-extrabold text-[#00ff9d] tabular-nums" style={{ textShadow: "0 0 22px rgba(0,255,157,0.6)" }}>
                {Math.ceil(remaining)}
              </span>
              <span className="text-[10px] tracking-[0.35em] uppercase text-white/50 mt-1.5">saniye</span>
            </div>
            <div className="h-16 w-px bg-white/10" />
            <div>
              <div className="text-3xl md:text-4xl font-bold leading-tight">
                Chatte <span className="text-[#00ff9d]">1</span>, <span className="text-[#b445ff]">2</span> veya <span className="text-[#ffe14a]">3</span> yaz!
              </div>
              <div className="text-sm text-white/55 mt-1.5 tracking-wide">En çok oy alan klip oynatılacak</div>
            </div>
            <div className="h-16 w-px bg-white/10" />
            <div className="flex items-center gap-2 text-sm mono text-white/80">
              <Zap size={16} className="text-[#00ff9d]" />
              <span data-testid="total-votes">{totalVotes} oy</span>
            </div>
          </div>

          {/* 3 clip cards horizontally */}
          <div data-testid="clip-grid" className="w-full max-w-[1400px] grid grid-cols-3 gap-8 items-start">
            {clips.map((c, idx) => {
              const n = idx + 1;
              const accent = n === 1 ? "#00ff9d" : n === 2 ? "#b445ff" : "#ffe14a";
              return (
                <div
                  key={c.id || idx}
                  data-testid={`clip-card-${n}`}
                  className="rounded-2xl border border-white/8 bg-black/45 backdrop-blur overflow-hidden flex flex-col fade-in transition-transform hover:-translate-y-1"
                  style={{ animationDelay: `${idx * 90}ms`, boxShadow: `0 0 24px -8px ${accent}55` }}
                >
                  <div className="relative aspect-video bg-black overflow-hidden">
                    {c.thumbnail_url ? (
                      <img src={c.thumbnail_url} alt="" className="w-full h-full object-cover" loading="lazy" />
                    ) : (
                      <div className="w-full h-full bg-white/5" />
                    )}
                    <div className="absolute bottom-2 left-2 px-2 py-1 rounded-md bg-black/70 backdrop-blur text-[11px] mono uppercase tracking-wider">
                      {(c.view_count || 0).toLocaleString("tr-TR")} Görüntülenme
                    </div>
                  </div>
                  <div className="px-4 pt-3 pb-3">
                    <div className="text-base font-semibold truncate">{c.title}</div>
                    <div className="text-[11px] mono text-white/50 mt-1 truncate">
                      {c.creator ? `@${c.creator}` : ""}
                      {c.created_at ? ` · ${formatDate(c.created_at)}` : ""}
                    </div>
                  </div>
                  <div className="px-4 py-3 border-t border-white/8 flex items-center justify-between">
                    <div className="mono text-4xl font-extrabold leading-none" style={{ color: accent, textShadow: `0 0 14px ${accent}77` }}>
                      {n}
                    </div>
                    <div data-testid={`clip-votes-${n}`} className="mono text-sm font-bold" style={{ color: accent }}>
                      {votes[n] || 0} oy
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Progress bar */}
          <div className="w-full max-w-[1400px] h-1.5 rounded-full bg-white/5 overflow-hidden">
            <div
              data-testid="countdown-bar"
              className="h-full bg-gradient-to-r from-[#00ff9d] via-[#7cffd0] to-[#b445ff] transition-[width] duration-100"
              style={{ width: `${timeRatio * 100}%`, boxShadow: "0 0 10px #00ff9d" }}
            />
          </div>
        </div>
      )}

      {/* ---------- LIVE CHAT OVERLAY (right side, VOTING only) ---------- */}
      {chatEnabled && phase === PHASE.VOTING && (
        <div data-testid="chat-overlay" className="absolute right-6 top-24 bottom-24 w-[280px] z-30 pointer-events-none flex flex-col justify-end gap-1.5 fade-in">
          <div className="text-[10px] tracking-[0.4em] uppercase text-white/40 mono mb-1 pl-1">Canlı Sohbet</div>
          {chatFeed.slice(-10).map((m) => {
            const voteMatch = m.text.match(/^([123])\s*$/);
            const isVote = !!voteMatch;
            const voteColor = isVote
              ? (voteMatch[1] === "1" ? "#00ff9d" : voteMatch[1] === "2" ? "#b445ff" : "#ffe14a")
              : null;
            return (
              <div
                key={m.id}
                className="px-3 py-1.5 rounded-lg bg-black/55 backdrop-blur border text-sm truncate"
                style={{
                  borderColor: isVote ? `${voteColor}88` : "rgba(255,255,255,0.06)",
                  boxShadow: isVote ? `0 0 12px -4px ${voteColor}` : "none",
                }}
              >
                <span className="mono text-[11px] font-bold mr-2" style={{ color: m.color || "#7cffd0" }}>
                  {m.username}
                </span>
                <span className={isVote ? "mono font-extrabold text-lg align-middle" : "text-white/85"}
                      style={isVote ? { color: voteColor } : {}}>
                  {m.text}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* ---------- REVEALING (2s dramatic winner announcement) ---------- */}
      {phase === PHASE.REVEALING && winnerIdx !== null && clips[winnerIdx - 1] && (
        <div data-testid="reveal-screen" className="absolute inset-0 z-25 flex flex-col items-center justify-center gap-6">
          <div className="reveal-flash" />
          <div className="text-sm tracking-[0.5em] uppercase text-white/60 fade-in">Kazanan</div>
          <div
            className="reveal-number mono font-extrabold leading-none"
            style={{
              color: winnerIdx === 1 ? "#00ff9d" : winnerIdx === 2 ? "#b445ff" : "#ffe14a",
              textShadow: `0 0 60px ${winnerIdx === 1 ? "#00ff9d" : winnerIdx === 2 ? "#b445ff" : "#ffe14a"}`,
            }}
          >
            #{winnerIdx}
          </div>
          <div className="text-2xl md:text-3xl font-bold max-w-3xl truncate px-8 text-center fade-in">
            {clips[winnerIdx - 1].title}
          </div>
          <div className="mono text-sm text-white/50">
            {(votes[winnerIdx] || 0)} oy ile kazandı
          </div>
        </div>
      )}

      {/* ---------- PLAYING (windowed, not fullscreen) ---------- */}
      {phase === PHASE.PLAYING && winnerIdx !== null && clips[winnerIdx - 1] && (
        <div data-testid="playing-screen" className="absolute inset-0 z-10 flex flex-col items-center justify-center px-10 py-16 gap-5">

          {/* winner banner */}
          <div className="fade-in flex items-center gap-3 px-5 py-2.5 rounded-full border border-[#00ff9d]/50 bg-black/60 backdrop-blur">
            <Trophy size={16} className="text-[#00ff9d]" />
            <span className="text-xs tracking-[0.35em] uppercase text-white/70">Kazanan</span>
            <span className="mono font-bold text-[#00ff9d] text-lg">#{winnerIdx}</span>
            <span className="mono text-xs text-white/50">{(votes[winnerIdx] || 0)} oy</span>
          </div>

          {/* Centered video window */}
          <div
            className="relative rounded-2xl overflow-hidden border border-[#00ff9d]/40 bg-black fade-in"
            style={{
              width: "min(70vw, 1100px)",
              aspectRatio: "16 / 9",
              boxShadow: "0 0 42px -6px rgba(0,255,157,0.45), 0 0 42px -6px rgba(180,69,255,0.35)",
            }}
          >
            <video
              data-testid="winner-video"
              ref={videoRef}
              className="w-full h-full object-contain bg-black"
              autoPlay
              playsInline
              controls={false}
            />
            {/* video progress inside the window */}
            <div className="absolute bottom-0 left-0 right-0 h-1.5 bg-black/50">
              <div
                data-testid="video-progress"
                className="h-full bg-gradient-to-r from-[#00ff9d] to-[#b445ff]"
                style={{ width: `${videoProgress}%`, boxShadow: "0 0 10px #00ff9d" }}
              />
            </div>
          </div>

          {/* Clip meta below the window */}
          <div className="text-center max-w-3xl fade-in">
            <div className="text-xl md:text-2xl font-bold truncate">{clips[winnerIdx - 1].title}</div>
            <div className="text-xs text-white/50 mt-2 mono tracking-wider">
              {clips[winnerIdx - 1].creator ? `@${clips[winnerIdx - 1].creator}` : ""}
              {clips[winnerIdx - 1].category ? ` · ${clips[winnerIdx - 1].category}` : ""}
              {clips[winnerIdx - 1].view_count ? ` · ${clips[winnerIdx - 1].view_count.toLocaleString("tr-TR")} görüntülenme` : ""}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
