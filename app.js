<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Neverending Story</title>
  <link rel="manifest" href="manifest.json" />
  <meta name="theme-color" content="#0b1220" />
  <style>
    body { margin:0; font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; background:#0b1220; color:#e7eefc; }
    .wrap { max-width: 900px; margin: 0 auto; padding: 18px; }
    .card { background:#111b31; border:1px solid #223257; border-radius: 14px; padding: 16px; margin-bottom: 14px; }
    .row { display:flex; gap:10px; flex-wrap:wrap; }
    input, select, textarea { background:#0b1220; color:#e7eefc; border:1px solid #2a3a66; border-radius:10px; padding:10px; }
    textarea { width:100%; min-height: 110px; }
    button { background:#2a66ff; color:white; border:0; border-radius: 12px; padding: 10px 14px; font-weight: 600; }
    button.secondary { background:#24304f; }
    button:disabled { opacity:.55; }
    .muted { opacity:.75; }
    .choices { display:flex; flex-direction:column; gap:10px; margin-top:12px; }
    .choiceBtn { text-align:left; }
    .pill { display:inline-block; padding: 4px 10px; border-radius:999px; background:#24304f; font-size: 12px; }
    .story { white-space: pre-wrap; line-height:1.45; font-size: 16px; }
    details { margin-top: 10px; }
    summary { cursor:pointer; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:10px;">
      <div style="font-weight:800;font-size:18px;">
        Neverending Story <span id="campaignPill" class="pill">No campaign</span>
      </div>

      <div class="row">
        <!-- IMPORTANT: app.js expects backToLibraryBtn -->
        <button id="backToLibraryBtn" class="secondary">Library</button>

        <button id="replayBtn" class="secondary">Replay</button>

        <!-- These two are optional, but adding them makes the UI clean.
             app.js will also manage them (enable/disable + pause/resume label). -->
        <button id="pauseBtn" class="secondary">Pause</button>
        <button id="stopBtn" class="secondary">Stop</button>

        <button id="undoBtn" class="secondary">Undo</button>
      </div>
    </div>

    <div id="setupCard" class="card">
      <div class="row">
        <div style="flex:1;min-width:260px;">
          <div class="muted">Worker URL</div>
          <input id="workerUrl" placeholder="https://your-worker.workers.dev/" style="width:100%;" />
        </div>
        <div style="flex:1;min-width:220px;">
          <div class="muted">Campaign name</div>
          <input id="campaignName" placeholder="Pallimustus" style="width:100%;" />
        </div>
      </div>

      <div class="row" style="margin-top:10px;">
        <div>
          <div class="muted">Rating</div>
          <select id="rating">
            <option>PG</option>
            <option selected>PG-13</option>
            <option>R</option>
          </select>
        </div>
        <div>
          <div class="muted">Pacing</div>
          <select id="pacing">
            <option>short</option>
            <option>medium</option>
            <option selected>long</option>
          </select>
        </div>
        <div>
          <div class="muted">Voice</div>
          <select id="ttsMode">
            <option value="off" selected>Off</option>
            <option value="on">On (English)</option>
          </select>
        </div>
      </div>

      <div style="margin-top:10px;">
        <div class="muted">Story seed (what kind of story to start)</div>
        <textarea id="seed" placeholder="Example: Dark fantasy coastal city. I am a retired paratrooper turned investigator..."></textarea>
      </div>

      <div class="row" style="margin-top:10px;">
        <button id="startBtn">Start</button>
        <button id="loadBtn" class="secondary">Load</button>
        <button id="wipeBtn" class="secondary">Wipe</button>
      </div>
    </div>

    <div id="playCard" class="card" style="display:none;">
      <div id="statusLine" class="muted">Ready.</div>

      <div class="card" style="background:#0b1220;border-color:#223257;">
        <div id="storyText" class="story"></div>
      </div>

      <div class="choices" id="choices"></div>

      <div style="margin-top:12px;">
        <div class="muted">Something else (type your action)</div>
        <div class="row">
          <input id="wildInput" style="flex:1;min-width:240px;" placeholder="e.g., I try to bribe the guard and slip past..." />
          <button id="wildBtn">Do Something Else</button>
          <button id="continueBtn" class="secondary">Continue</button>
        </div>
      </div>

      <details>
        <summary class="muted">Debug / Memory</summary>
        <pre id="memoryBox" style="white-space:pre-wrap;"></pre>
      </details>
    </div>
  </div>

  <script src="app.js"></script>
</body>
</html>
