/* =========================================================================
   Radha Raman Fruit Shop - app.js
   -------------------------------------------------------------------------
   Single shop, social-feed style ordering app.

   Data flow (no P2P / no WebRTC / no Firebase):
   - Owner creates or deletes posts on their device. Posts are written to
     IndexedDB immediately, and the feed updates instantly for the owner.
   - Every create/delete then AUTO-PUBLISHES in the background: the full
     post list is pushed to a JSON file in a GitHub repository (via the
     GitHub Contents API, using a fine-grained personal access token
     stored only on the owner's device). The manual "Publish to Live
     Site" button still exists as a status display and manual retry, but
     the owner does not need to press it for normal changes to go live.
     If a background publish fails (e.g. offline), it keeps retrying on
     every poll tick until it succeeds - so a change never gets silently
     stuck unpublished.
   - Every device (owner AND every customer, on first load and every 10
     seconds after, in a loop that never stops while the app is open)
     polls that published JSON file with cache-busting and no-store
     fetch options, diffs it against local storage, and merges in any
     new or removed posts - so a delete/publish shows up on every
     customer's phone within one 10-second cycle, including on a
     customer's very first visit to the site, with no login or setup
     needed on their end. The service worker explicitly excludes this
     data file and the GitHub API from its cache so nothing ever serves
     a stale post list.
   - The repo/branch/file-path the app polls (GH_SOURCE below) is public
     information - it's just a URL, not a secret - so it's shipped with
     the site itself and every device knows where to look immediately.
     The personal access token used to PUBLISH (write) is different: it
     stays only in the owner's own browser localStorage and is never
     required for a customer to read posts.
   - Customer contact goes through WhatsApp: tapping "Chat" opens a
     wa.me link to the shop's WhatsApp number with a prefilled message,
     instead of an in-app chat thread.
   ========================================================================= */

/* ---------------------------------------------------------------------
   Configuration
   --------------------------------------------------------------------- */
const CONFIG = {
  SHOP_NAME: "Radha Raman Fruit Shop",
  OWNER_NAME: "Rupak Ghosh",
  SHOP_PHONE: "9387361589",
  WHATSAPP_NUMBER: "918549949827", // country code + number, digits only
  OWNER_USERNAME: "admin",
  OWNER_PASSWORD: "rupak123",
  APP_VERSION: "2.0",

  MAX_IMAGE_DIM: 1280,
  MAX_IMAGE_BYTES: 900 * 1024,
  IMAGE_JPEG_QUALITY: 0.78,

  DB_NAME: "radharaman_db",
  DB_VERSION: 3,
  STORES: ["posts", "reactions"],

  // How often every device checks the published data file for updates.
  POLL_INTERVAL_MS: 10000,
  // Owner: how long after a local change to wait before it's safe to
  // consider "pending publish" (purely informational in the UI).
  PUBLISH_DEBOUNCE_MS: 60000
};

/* ---------------------------------------------------------------------
   GitHub sync source (public, ships with the site)
   -------------------------------------------------------------------
   This is WHERE every device reads published posts from. It is not a
   secret - it's the same info as a public web address - so it is safe
   to bake into the shipped site and does not depend on any per-device
   setup. Fill these in once (to match the repo you publish to) and
   every customer's first-ever page load will already know where to
   pull posts from.
   --------------------------------------------------------------------- */
const GH_SOURCE = {
  owner: "ronakksdevelopment",
  repo: "radharaman",
  branch: "main",
  path: "data/posts.json"
};
function githubSourceIsComplete(src) {
  return !!(src && src.owner && src.repo && src.branch && src.path
    && src.owner !== "YOUR_GITHUB_USERNAME" && src.repo !== "YOUR_REPO_NAME");
}

/* The publish TOKEN, by contrast, grants write access and must never be
   shipped with the site - it lives only in the owner's own browser,
   entered once through the Publish screen and stored in localStorage
   on that device only. Everything else about where to publish (owner/
   repo/branch/path) is taken from GH_SOURCE above so the two can never
   drift out of sync. */
const GH_TOKEN_STORAGE_KEY = "rr_github_token";

function getGithubToken() {
  return localStorage.getItem(GH_TOKEN_STORAGE_KEY) || "";
}
function setGithubToken(token) {
  if (token) localStorage.setItem(GH_TOKEN_STORAGE_KEY, token);
  else localStorage.removeItem(GH_TOKEN_STORAGE_KEY);
}
/* The raw content URL is what every device (owner + customers) polls to
   pick up new posts - it requires no authentication since GitHub raw
   content for a public repo is public. */
function githubRawUrl(src) {
  // Double cache-bust: a unique query string PLUS a random component, so
  // no browser, CDN, proxy, or service worker can ever match this URL
  // against a previously cached response - every poll is a guaranteed
  // fresh network hit.
  return "https://raw.githubusercontent.com/" + src.owner + "/" + src.repo + "/" + src.branch + "/" + src.path
    + "?t=" + Date.now() + "&r=" + Math.random().toString(36).slice(2);
}
function githubContentsApiUrl(src) {
  return "https://api.github.com/repos/" + src.owner + "/" + src.repo + "/contents/" + src.path;
}

/* ---------------------------------------------------------------------
   Application state
   --------------------------------------------------------------------- */
const STATE = {
  role: null,           // "owner" | "customer" | null
  customer: null,
  currentScreen: "home",
  theme: "light",
  posts: [],
  activeReactionPicker: null,
  db: null,
  deferredInstallPrompt: null,
  pollTimer: null,
  lastPublishedAt: null
};

/* ---------------------------------------------------------------------
   Small helpers
   --------------------------------------------------------------------- */
function $(sel, root) { return (root || document).querySelector(sel); }
function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

function uid(prefix) {
  return (prefix || "id") + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 9);
}

function escapeHTML(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeText(str, maxLen) {
  if (!str) return "";
  let s = String(str).replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (maxLen) s = s.slice(0, maxLen);
  return s;
}

function toast(msg, ms) {
  const host = $("#toastHost");
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), ms || 2600);
}

function validateMobile(v) {
  return /^[6-9]\d{9}$/.test(v);
}

function pad2(n) { return String(n).padStart(2, "0"); }

function formatDisplayDate(d) {
  const date = d || new Date();
  return pad2(date.getDate()) + "-" + pad2(date.getMonth() + 1) + "-" + date.getFullYear();
}
function formatDisplayTime(d) {
  const date = d || new Date();
  let h = date.getHours();
  const m = pad2(date.getMinutes());
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12; if (h === 0) h = 12;
  return pad2(h) + ":" + m + " " + ampm;
}
function relativeOrTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  return formatDisplayDate(d) + " " + formatDisplayTime(d);
}

/* ---------------------------------------------------------------------
   WhatsApp deep link
   --------------------------------------------------------------------- */
function buildWhatsAppLink(message) {
  const text = encodeURIComponent(message || ("Hi " + CONFIG.OWNER_NAME + ", I'd like to ask about " + CONFIG.SHOP_NAME + "."));
  return "https://wa.me/" + CONFIG.WHATSAPP_NUMBER + "?text=" + text;
}
function openWhatsAppChat(context) {
  const name = STATE.customer ? STATE.customer.name : "";
  let message = "Hi " + CONFIG.OWNER_NAME + ", ";
  if (name) message += "this is " + name + ". ";
  message += context ? context : "I'd like to ask about a product on the shop app.";
  window.open(buildWhatsAppLink(message), "_blank", "noopener");
}

/* ---------------------------------------------------------------------
   IndexedDB - local post/reaction cache
   --------------------------------------------------------------------- */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("posts")) {
        const s = db.createObjectStore("posts", { keyPath: "postId" });
        s.createIndex("createdAt", "createdAt");
      }
      if (!db.objectStoreNames.contains("reactions")) {
        const s = db.createObjectStore("reactions", { keyPath: "reactionId" });
        s.createIndex("postId", "postId");
      }
      // Older versions of this app used stores for P2P chat/peers/sessions
      // and per-device customer directories. None of that is needed now.
      ["messages", "sessions", "peers", "customers"].forEach(name => {
        if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
      });
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}
function dbPut(store, value) {
  return new Promise((resolve, reject) => {
    const tx = STATE.db.transaction(store, "readwrite");
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve(value);
    tx.onerror = (e) => reject(e.target.error);
  });
}
function dbGetAll(store) {
  return new Promise((resolve, reject) => {
    const tx = STATE.db.transaction(store, "readonly");
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = (e) => reject(e.target.error);
  });
}
function dbGet(store, key) {
  return new Promise((resolve, reject) => {
    const tx = STATE.db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = (e) => reject(e.target.error);
  });
}
function dbGetByIndex(store, index, value) {
  return new Promise((resolve, reject) => {
    const tx = STATE.db.transaction(store, "readonly");
    const req = tx.objectStore(store).index(index).getAll(value);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = (e) => reject(e.target.error);
  });
}
function dbDelete(store, key) {
  return new Promise((resolve, reject) => {
    const tx = STATE.db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = (e) => reject(e.target.error);
  });
}

/* ---------------------------------------------------------------------
   Auth / session
   --------------------------------------------------------------------- */
function restoreSession() {
  const role = localStorage.getItem("rr_role");
  if (role === "owner") {
    STATE.role = "owner";
    enterApp();
  } else if (role === "customer") {
    const raw = localStorage.getItem("rr_customer");
    if (raw) {
      try { STATE.customer = JSON.parse(raw); } catch (e) { STATE.customer = null; }
    }
    if (STATE.customer && STATE.customer.mobile) {
      STATE.role = "customer";
      enterApp();
    } else {
      showScreenGroup("entry");
    }
  } else {
    showScreenGroup("entry");
  }
}
function loginOwner(username, password) {
  if (username === CONFIG.OWNER_USERNAME && password === CONFIG.OWNER_PASSWORD) {
    STATE.role = "owner";
    localStorage.setItem("rr_role", "owner");
    enterApp();
    return true;
  }
  return false;
}
function loginCustomer(mobile, name) {
  const customer = {
    id: localStorage.getItem("rr_customer_id") || uid("cust"),
    mobile: mobile,
    name: name || "Guest",
    joinedAt: new Date().toISOString()
  };
  localStorage.setItem("rr_customer_id", customer.id);
  localStorage.setItem("rr_role", "customer");
  localStorage.setItem("rr_customer", JSON.stringify(customer));
  STATE.role = "customer";
  STATE.customer = customer;
  enterApp();
}
function logout() {
  stopPolling();
  localStorage.removeItem("rr_role");
  STATE.role = null;
  STATE.customer = null;
  $("#mainApp").classList.add("hidden");
  showScreenGroup("entry");
  toast("Logged out");
}

/* ---------------------------------------------------------------------
   Posts - local read/write
   --------------------------------------------------------------------- */
async function loadPostsFromDB() {
  const all = await dbGetAll("posts");
  all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  STATE.posts = all;
  return all;
}

function compressImage(file) {
  return new Promise((resolve, reject) => {
    if (!file.type || !file.type.startsWith("image/")) {
      reject(new Error("Please choose a valid image file."));
      return;
    }
    const img = new Image();
    const reader = new FileReader();
    reader.onload = (e) => { img.src = e.target.result; };
    reader.onerror = () => reject(new Error("Could not read the image file."));
    img.onload = () => {
      let { width, height } = img;
      const maxDim = CONFIG.MAX_IMAGE_DIM;
      if (width > maxDim || height > maxDim) {
        if (width > height) { height = Math.round(height * (maxDim / width)); width = maxDim; }
        else { width = Math.round(width * (maxDim / height)); height = maxDim; }
      }
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL("image/jpeg", CONFIG.IMAGE_JPEG_QUALITY);
      resolve(dataUrl);
    };
    img.onerror = () => reject(new Error("Could not load the image."));
    reader.readAsDataURL(file);
  });
}

async function createPost({ imageData, caption, category }) {
  const now = new Date();
  const post = {
    postId: uid("post"),
    shopId: "radharaman",
    author: CONFIG.OWNER_NAME,
    imageData: imageData,
    caption: sanitizeText(caption, 600),
    category: category || "",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    date: formatDisplayDate(now),
    time: formatDisplayTime(now),
    status: "published"
  };
  await dbPut("posts", post);
  await loadPostsFromDB();
  renderFeed();
  markPendingPublish();
  autoPublishAfterChange();
  return post;
}

async function deletePost(postId) {
  if (STATE.role !== "owner") return false;
  await dbDelete("posts", postId);
  const relatedReactions = await dbGetByIndex("reactions", "postId", postId);
  for (const r of relatedReactions) await dbDelete("reactions", r.reactionId);
  await loadPostsFromDB();
  renderFeed();
  markPendingPublish();
  autoPublishAfterChange();
  return true;
}

/* Fire-and-forget auto-publish, called right after any local change
   (create/delete). This is what makes delete/publish actually sync to
   every owner and customer device: instead of relying on the owner to
   remember to tap "Publish to Live Site", every change is pushed to
   GitHub immediately in the background. The manual Publish button and
   panel stay in place as a visible status/retry control, but the
   owner no longer has to use it for normal changes to go live. */
let autoPublishTimer = null;
function autoPublishAfterChange() {
  if (STATE.role !== "owner") return;
  if (!githubSourceIsComplete(GH_SOURCE) || !getGithubToken()) return; // nothing to auto-publish to yet
  // Debounce briefly so rapid-fire actions (e.g. deleting several posts
  // in a row) collapse into a single publish instead of racing multiple
  // overlapping GitHub writes against each other.
  if (autoPublishTimer) clearTimeout(autoPublishTimer);
  autoPublishTimer = setTimeout(() => {
    autoPublishTimer = null;
    publishToGithub({ silent: true });
  }, 1200);
}

/* Merge posts coming from the published GitHub data file into local
   storage. Additions and removals are both reconciled so every device
   converges on the same list. */
async function mergeRemotePosts(remotePosts) {
  if (!Array.isArray(remotePosts)) return false;
  const localPosts = await dbGetAll("posts");
  const localIds = new Set(localPosts.map(p => p.postId));
  const remoteIds = new Set(remotePosts.map(p => p.postId));
  let changed = false;

  for (const post of remotePosts) {
    if (!localIds.has(post.postId)) {
      await dbPut("posts", post);
      changed = true;
    }
  }
  // A post that is no longer in the published list was deleted by the
  // owner elsewhere - remove it locally too (owner's own device already
  // has authoritative local state, so skip this on the owner's device to
  // avoid racing against posts not yet published).
  if (STATE.role !== "owner") {
    for (const post of localPosts) {
      if (!remoteIds.has(post.postId)) {
        await dbDelete("posts", post.postId);
        const relatedReactions = await dbGetByIndex("reactions", "postId", post.postId);
        for (const r of relatedReactions) await dbDelete("reactions", r.reactionId);
        changed = true;
      }
    }
  }
  if (changed) {
    await loadPostsFromDB();
    renderFeed();
  }
  return changed;
}

/* ---------------------------------------------------------------------
   Reactions (likes)
   --------------------------------------------------------------------- */
const REACTIONS = {
  like:      { emoji: "\u2764\ufe0f", color: "var(--watermelon)", label: "Like" },
  thumbsup:  { emoji: "\ud83d\udc4d", color: "var(--blueberry)",  label: "Thumbs up" },
  love:      { emoji: "\ud83e\udd70", color: "var(--grape)",      label: "Love it" },
  laugh:     { emoji: "\ud83d\ude02", color: "var(--banana-dark)", label: "Funny" },
  wow:       { emoji: "\ud83d\ude2e", color: "var(--mango)",      label: "Wow" },
  sad:       { emoji: "\ud83d\ude22", color: "var(--kiwi-dark)",  label: "Sad" }
};

async function toggleReaction(postId, type) {
  const actorId = STATE.role === "owner" ? "owner" : (STATE.customer ? STATE.customer.id : "guest");
  const all = await dbGetByIndex("reactions", "postId", postId);
  const mine = all.find(r => r.actorId === actorId);
  let reaction;
  if (mine && mine.type === type) {
    await dbDelete("reactions", mine.reactionId);
    renderFeed();
    return null;
  }
  if (mine) {
    mine.type = type; mine.createdAt = new Date().toISOString();
    reaction = mine;
  } else {
    reaction = { reactionId: uid("rxn"), postId, actorId, type, createdAt: new Date().toISOString() };
  }
  await dbPut("reactions", reaction);
  renderFeed();
  return reaction;
}
async function getReactionsForPost(postId) {
  return dbGetByIndex("reactions", "postId", postId);
}

/* ---------------------------------------------------------------------
   GitHub publish (owner only) + cross-device polling (everyone)
   --------------------------------------------------------------------- */

/* Base64-encode UTF-8 text safely for the GitHub Contents API. */
function utf8ToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function appendPublishLog(line) {
  const log = $("#publishLog");
  if (!log) return;
  const time = formatDisplayTime();
  const el = document.createElement("div");
  el.textContent = "[" + time + "] " + line;
  if (log.firstChild && log.firstChild.textContent === "No publishes yet.") log.innerHTML = "";
  log.prepend(el);
  while (log.children.length > 30) log.removeChild(log.lastChild);
}

function markPendingPublish() {
  localStorage.setItem("rr_pending_publish", "1");
  renderPublishPanel();
}

/* Push the full local post list to GH_SOURCE via the Contents API.
   Requires the existing file's SHA for updates (the API rejects a
   write without it once the file already exists). Owner-only: needs
   a token, which only the owner's device has. */
let publishInFlight = false;
async function publishToGithub(opts) {
  const silent = !!(opts && opts.silent);
  if (!githubSourceIsComplete(GH_SOURCE)) {
    if (!silent) toast("GH_SOURCE isn't set up in app.js yet - see the comment at the top of the file.");
    return false;
  }
  const token = getGithubToken();
  if (!token) {
    if (!silent) { toast("Add your GitHub publish token first."); navigateTo("publish"); }
    return false;
  }
  // Avoid two overlapping publishes stepping on each other (e.g. an
  // auto-publish firing while the owner also taps the manual button).
  // If one is already running, queue a follow-up so the latest local
  // state still ends up published once the current write finishes.
  if (publishInFlight) {
    autoPublishAfterChange();
    return false;
  }
  publishInFlight = true;
  const btn = $("#btnPublishNow");
  if (btn && !silent) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>&nbsp; Publishing…'; }
  try {
    const posts = await dbGetAll("posts");
    posts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const payload = { updatedAt: new Date().toISOString(), posts };
    const content = utf8ToBase64(JSON.stringify(payload, null, 2));

    // Look up the current file SHA, if it already exists, so the API
    // treats this as an update rather than a conflicting create. A 404
    // here just means the file (or its parent folder) doesn't exist
    // yet on this branch - that's expected on first publish, GitHub
    // creates any missing folders automatically from the PUT below, so
    // we simply proceed with sha = null (create instead of update).
    let sha = null;
    let getRes;
    try {
      getRes = await fetch(githubContentsApiUrl(GH_SOURCE) + "?ref=" + encodeURIComponent(GH_SOURCE.branch) + "&_=" + Date.now(), {
        cache: "no-store",
        headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" }
      });
    } catch (netErr) {
      throw new Error(networkErrorMessage(netErr));
    }
    if (getRes.status === 200) {
      const getData = await getRes.json();
      sha = getData.sha;
    } else if (getRes.status === 401 || getRes.status === 403) {
      throw new Error("GitHub rejected the token (" + getRes.status + "). Check it's valid, not expired, and has Contents: Read and write access on this repo.");
    } else if (getRes.status !== 404) {
      const errBody = await getRes.text();
      throw new Error("GitHub lookup failed (" + getRes.status + "): " + errBody.slice(0, 200));
    }
    // status 404 (file/folder missing) falls through here with sha still
    // null - this is the "reset and auto-create" path: the very next
    // PUT below creates data/posts.json (and the data/ folder with it)
    // from scratch, so a deleted or never-existing folder/file heals
    // itself on the next publish with no manual setup needed.

    let putRes;
    try {
      putRes = await fetch(githubContentsApiUrl(GH_SOURCE), {
        method: "PUT",
        headers: {
          Authorization: "Bearer " + token,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          message: (sha ? "Update" : "Create") + " shop posts (" + posts.length + " posts) - " + new Date().toISOString(),
          content: content,
          branch: GH_SOURCE.branch,
          sha: sha || undefined
        })
      });
    } catch (netErr) {
      throw new Error(networkErrorMessage(netErr));
    }
    if (!putRes.ok) {
      const errBody = await putRes.text();
      let hint = "";
      if (putRes.status === 401 || putRes.status === 403) hint = " - check the token is valid and has Contents: Read and write access on this repo.";
      else if (putRes.status === 404) hint = " - check GH_SOURCE.owner/repo/branch in app.js match a real repo and branch the token can access.";
      else if (putRes.status === 409) hint = " - someone else published at the same moment; retrying automatically.";
      throw new Error("GitHub publish failed (" + putRes.status + ")" + hint + ": " + errBody.slice(0, 200));
    }

    STATE.lastPublishedAt = new Date().toISOString();
    localStorage.setItem("rr_last_published_at", STATE.lastPublishedAt);
    localStorage.removeItem("rr_pending_publish");
    appendPublishLog((sha ? "Published " : "Created data/posts.json and published ") + posts.length + " posts successfully" + (silent ? " (auto)" : "") + ".");
    if (!silent) toast("Published! Syncing to all devices now.");
    renderPublishPanel();
    return true;
  } catch (err) {
    appendPublishLog("Error: " + err.message);
    if (!silent) toast("Publish failed: " + err.message);
    // Leave rr_pending_publish set so the change is retried: either the
    // owner retries manually, or the next local change - or the next
    // poll tick's self-healing retry - triggers another auto-publish
    // attempt automatically.
    return false;
  } finally {
    publishInFlight = false;
    if (btn && !silent) { btn.disabled = false; btn.innerHTML = '<i class="fa-brands fa-github" aria-hidden="true"></i>&nbsp; Publish to Live Site'; }
  }
}

/* Turn a raw fetch()-level failure (TypeError: "Failed to fetch") into
   an actionable message. This is what shows up when the request never
   even reached GitHub - offline, DNS failure, CORS block, or a browser
   extension (ad blocker / privacy blocker) interfering - as opposed to
   a GitHub API error, which always comes back with a status code and
   is handled separately above. */
function networkErrorMessage(netErr) {
  if (!navigator.onLine) {
    return "You're offline - this device has no internet connection right now. It'll auto-retry once you're back online.";
  }
  return "Couldn't reach GitHub (network error: " + (netErr && netErr.message ? netErr.message : "failed to fetch") + "). Check your internet connection, and disable any ad-blocker or privacy extension for this site if the problem continues.";
}

/* Poll the published JSON file and merge any changes into local
   storage. Runs on EVERY device - owner and customers alike, logged in
   or not - as soon as the page loads, and every 10 seconds after.
   Reading GH_SOURCE requires no token, so a customer's very first
   visit already picks up whatever the owner has published. */
async function pollForUpdates() {
  if (!githubSourceIsComplete(GH_SOURCE)) return;
  try {
    // IMPORTANT: no custom headers here (no Cache-Control/Pragma). Those
    // trigger a CORS preflight (OPTIONS) request, and
    // raw.githubusercontent.com rejects preflighted requests entirely
    // (403 on OPTIONS), which makes every fetch() throw a generic
    // "Failed to fetch" with no useful reason. The cache: "no-store"
    // fetch option plus the random query string in githubRawUrl() are
    // enough to guarantee a fresh network hit without ever adding a
    // header that would trigger a preflight.
    const res = await fetch(githubRawUrl(GH_SOURCE), { cache: "no-store" });
    if (!res.ok) return; // file may not exist yet - nothing to merge
    const data = await res.json();
    await mergeRemotePosts(data.posts);
    if (STATE.role === "owner") {
      renderPublishPanel();
      // Self-healing retry: if an earlier auto-publish failed (e.g. the
      // owner was briefly offline) rr_pending_publish is still set, so
      // every poll tick also retries publishing until it succeeds -
      // this closes the loop so delete/publish always converges without
      // the owner needing to notice and manually retry.
      if (localStorage.getItem("rr_pending_publish") === "1" && getGithubToken() && !publishInFlight) {
        publishToGithub({ silent: true });
      }
    }
  } catch (err) {
    // Network hiccups or an unreachable file are expected occasionally
    // (e.g. offline devices) - fail silently and try again next tick.
  }
}

function startPolling() {
  stopPolling();
  pollForUpdates();
  STATE.pollTimer = setInterval(pollForUpdates, CONFIG.POLL_INTERVAL_MS);
}
function stopPolling() {
  if (STATE.pollTimer) { clearInterval(STATE.pollTimer); STATE.pollTimer = null; }
}

function renderPublishPanel() {
  if (STATE.role !== "owner") return;
  const sourceReady = githubSourceIsComplete(GH_SOURCE);
  const token = getGithubToken();
  const stamp = $("#publishStamp");
  const statusText = $("#publishStatusText");
  if (stamp && statusText) {
    if (!sourceReady) {
      stamp.className = "stamp off";
      stamp.innerHTML = '<i class="fa-solid fa-circle dot" aria-hidden="true"></i>NOT CONFIGURED';
      statusText.textContent = "Set GH_SOURCE in app.js";
    } else if (!token) {
      stamp.className = "stamp off";
      stamp.innerHTML = '<i class="fa-solid fa-circle dot" aria-hidden="true"></i>TOKEN NEEDED';
      statusText.textContent = GH_SOURCE.owner + "/" + GH_SOURCE.repo;
    } else {
      const pending = localStorage.getItem("rr_pending_publish") === "1";
      stamp.className = "stamp " + (pending ? "off" : "live");
      stamp.innerHTML = '<i class="fa-solid fa-circle dot" aria-hidden="true"></i>' + (pending ? "CHANGES PENDING" : "UP TO DATE");
      statusText.textContent = GH_SOURCE.owner + "/" + GH_SOURCE.repo;
    }
  }
  const countEl = $("#publishPostCount");
  if (countEl) countEl.textContent = STATE.posts.length;
  const lastEl = $("#publishLastPushed");
  if (lastEl) {
    const last = STATE.lastPublishedAt || localStorage.getItem("rr_last_published_at");
    lastEl.textContent = last ? relativeOrTime(last) : "Never";
  }

  const repoInfoEl = $("#ghRepoInfo");
  if (repoInfoEl) {
    repoInfoEl.textContent = sourceReady
      ? (GH_SOURCE.owner + "/" + GH_SOURCE.repo + " @ " + GH_SOURCE.branch + " → " + GH_SOURCE.path)
      : "Not set - edit GH_SOURCE at the top of app.js first.";
  }
  // Reflect the saved token into the form field (but never expose it
  // anywhere outside this device).
  if ($("#ghToken")) $("#ghToken").value = token;
}

/* ---------------------------------------------------------------------
   Install prompt (PWA)
   --------------------------------------------------------------------- */
const APP_ICON_URL = "https://i.ibb.co/Y44BFz8p/fruit-shop.png";
const MANIFEST_OBJ = {
  name: "Radha Raman Fruit Shop",
  short_name: "Radha Raman",
  start_url: ".",
  display: "standalone",
  background_color: "#FFF8ED",
  theme_color: "#E8871E",
  icons: [
    { src: APP_ICON_URL, sizes: "192x192", type: "image/png" },
    { src: APP_ICON_URL, sizes: "512x512", type: "image/png" }
  ]
};
function attachManifest() {
  try {
    if (document.getElementById("appManifestLink")) return;
    const json = JSON.stringify(MANIFEST_OBJ);
    const dataUrl = "data:application/manifest+json;charset=utf-8," + encodeURIComponent(json);
    const link = document.createElement("link");
    link.id = "appManifestLink";
    link.rel = "manifest";
    link.href = dataUrl;
    document.head.appendChild(link);
  } catch (e) { console.warn("Manifest attach failed", e); }
}

const SERVICE_WORKER_SRC = `
const CACHE = 'radharaman-v5';
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});
// Requests that must ALWAYS hit the network and must NEVER be cached or
// served from cache - this is the live post data (GitHub raw file) and
// the GitHub API itself. Serving these from cache is exactly what makes
// deletes/publishes look "stuck" for customers, so they are excluded
// from the cache-and-fallback strategy entirely.
function isNoCacheRequest(url) {
  return url.includes('raw.githubusercontent.com') ||
         url.includes('api.github.com') ||
         url.includes('/data/posts.json');
}
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (isNoCacheRequest(e.request.url)) {
    // IMPORTANT: never add custom headers (e.g. Cache-Control/Pragma) to
    // this passthrough fetch - api.github.com and raw.githubusercontent.com
    // reject CORS preflights, so any header outside the default set turns
    // every request into a silent "Failed to fetch" with no real reason.
    e.respondWith(fetch(e.request, { cache: 'no-store' }));
    return;
  }
  e.respondWith(
    fetch(e.request).then(res => {
      const resClone = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, resClone)).catch(()=>{});
      return res;
    }).catch(() => caches.match(e.request).then(cached => cached || caches.match('/')))
  );
});
`;
async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const dataUrl = "data:text/javascript;charset=utf-8," + encodeURIComponent(SERVICE_WORKER_SRC);
    const reg = await navigator.serviceWorker.register(dataUrl);
    // Force an immediate update check so a device that already has an
    // older worker installed (e.g. from before this fix) picks up the
    // new one on this load instead of silently continuing to run the
    // old, buggy fetch logic until some unrelated future refresh.
    try { await reg.update(); } catch (e) { /* update check is best-effort */ }
    STATE.swRegistered = true;
    return reg;
  } catch (e) {
    STATE.swRegistered = false;
    console.warn("Service worker registration unavailable in this browser:", e.message);
  }
}
function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
function isInStandaloneMode() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}
function initInstallPrompt() {
  attachManifest();
  registerServiceWorker();

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    STATE.deferredInstallPrompt = e;
    const btn = $("#btnInstallApp");
    if (btn) { btn.disabled = false; btn.textContent = "Install"; }
  });
  window.addEventListener("appinstalled", () => {
    toast("App installed");
    STATE.deferredInstallPrompt = null;
    const btn = $("#btnInstallApp");
    if (btn) { btn.disabled = true; btn.textContent = "Installed"; }
  });

  if (isInStandaloneMode()) {
    const btn = $("#btnInstallApp");
    if (btn) { btn.disabled = true; btn.textContent = "Installed"; }
  }
}
async function triggerInstall() {
  if (isInStandaloneMode()) {
    toast("Already installed as an app.");
    return;
  }
  if (isIOS()) {
    openModal("Add to Home Screen (iOS)", `
        <div style="display:flex;flex-direction:column;gap:12px;">
          <p>iOS doesn't allow apps to trigger install directly. To install as a real full-screen app:</p>
          <ol style="padding-left:20px;display:flex;flex-direction:column;gap:8px;">
            <li>Tap the <b>Share</b> icon <i class="fa-solid fa-arrow-up-from-bracket"></i> in Safari's toolbar</li>
            <li>Scroll down and tap <b>Add to Home Screen</b></li>
            <li>Tap <b>Add</b> in the top right</li>
          </ol>
          <p style="opacity:.75;font-size:13px;">Once added, open it from your Home Screen icon (not Safari) - it'll run full-screen like a native app, with no browser bar.</p>
        </div>`);
    return;
  }
  if (!STATE.deferredInstallPrompt) {
    toast("Install isn't available yet - if you just opened the page, wait a moment, or use your browser menu's 'Add to Home Screen' / 'Install app' option.");
    return;
  }
  STATE.deferredInstallPrompt.prompt();
  const choice = await STATE.deferredInstallPrompt.userChoice;
  STATE.deferredInstallPrompt = null;
  if (choice && choice.outcome === "dismissed") {
    const btn = $("#btnInstallApp");
    if (btn) btn.disabled = false;
  }
}

/* ---------------------------------------------------------------------
   Screen navigation
   --------------------------------------------------------------------- */
function showScreenGroup(group) {
  ["screen-entry", "screen-customer-login", "screen-owner-login"].forEach(id => $("#" + id).classList.add("hidden"));
  if (group === "entry") $("#screen-entry").classList.remove("hidden");
  if (group === "customer-login") $("#screen-customer-login").classList.remove("hidden");
  if (group === "owner-login") $("#screen-owner-login").classList.remove("hidden");
}
function enterApp() {
  $("#screen-entry").classList.add("hidden");
  $("#screen-customer-login").classList.add("hidden");
  $("#screen-owner-login").classList.add("hidden");
  $("#mainApp").classList.remove("hidden");
  $("#navOwner").classList.toggle("hidden", STATE.role !== "owner");
  $("#navCustomer").classList.toggle("hidden", STATE.role === "owner");
  ["create", "publish"].forEach(s => { if (STATE.role !== "owner") $("#screen-" + s) && $("#screen-" + s).classList.add("hidden"); });
  navigateTo("home");
  renderProfile();
  renderSessionCodeEverywhere();
  loadPostsFromDB().then(renderFeed);
  startPolling();
}
const SCREEN_TITLES = { home: "Home feed", create: "New post", publish: "Publish updates", activity: "Activity", profile: "Your profile" };
function navigateTo(screen) {
  STATE.currentScreen = screen;
  $all(".screen").forEach(s => s.classList.add("hidden"));
  const target = $("#screen-" + screen);
  if (target) target.classList.remove("hidden");
  $all(".nav-item").forEach(btn => {
    const match = btn.dataset.screen === screen;
    btn.classList.toggle("active", match);
    if (match) btn.setAttribute("aria-current", "page"); else btn.removeAttribute("aria-current");
  });
  const sub = $("#topbarSub");
  if (sub) sub.textContent = SCREEN_TITLES[screen] || "";
  if (screen === "profile") renderProfile();
  if (screen === "publish") renderPublishPanel();
  if (screen === "activity") renderActivity();
}
function renderSessionCodeEverywhere() {
  const chip = $("#feedSessionChip");
  if (chip) chip.textContent = formatDisplayDate();
  const profileDate = $("#profileSessionDate");
  if (profileDate) profileDate.textContent = formatDisplayDate();
}

/* ---------------------------------------------------------------------
   Rendering: profile
   --------------------------------------------------------------------- */
function renderProfile() {
  const avatar = $("#profileAvatar");
  const nameEl = $("#profileName");
  const subEl = $("#profileSub");
  if (STATE.role === "owner") {
    avatar.innerHTML = '<img src="https://i.ibb.co/Y44BFz8p/fruit-shop.png" alt="" class="logo-img">';
    nameEl.textContent = CONFIG.OWNER_NAME;
    subEl.innerHTML = '<span class="owner-badge">OWNER / ADMIN</span>';
  } else {
    avatar.innerHTML = '<i class="fa-solid fa-user" style="color:#fff;font-size:30px;" aria-hidden="true"></i>';
    nameEl.textContent = STATE.customer ? STATE.customer.name : "Guest";
    subEl.textContent = "Customer";
  }
  $("#btnInstallApp").disabled = !STATE.deferredInstallPrompt;
}

/* ---------------------------------------------------------------------
   Rendering: feed
   --------------------------------------------------------------------- */
async function renderFeed() {
  const list = $("#feedList");
  const posts = STATE.posts;
  if (!posts.length) {
    list.innerHTML = `<div class="empty-state">
      <i class="fa-solid fa-basket-shopping" style="font-size:42px;color:var(--ink-soft);" aria-hidden="true"></i>
      <h3>No posts yet</h3>
      <p>${STATE.role === "owner" ? "Tap Create to post your first product photo." : "Check back soon - new posts appear here automatically."}</p>
    </div>`;
    return;
  }
  const chunks = await Promise.all(posts.map(renderPostCard));
  list.innerHTML = chunks.join("");
  attachFeedEventListeners();
}

async function renderPostCard(post) {
  const reactions = await getReactionsForPost(post.postId);
  const actorId = STATE.role === "owner" ? "owner" : (STATE.customer ? STATE.customer.id : "guest");
  const myReaction = reactions.find(r => r.actorId === actorId);
  const counts = {};
  reactions.forEach(r => { counts[r.type] = (counts[r.type] || 0) + 1; });
  const topTypes = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 3);
  const totalReactions = reactions.length;
  const isOwnerViewer = STATE.role === "owner";
  return `
  <article class="post-card" data-post-id="${escapeHTML(post.postId)}">
    <div class="post-head">
      <div class="post-avatar" aria-hidden="true"><img src="https://i.ibb.co/Y44BFz8p/fruit-shop.png" alt="" class="logo-img"></div>
      <div class="post-headtext">
        <div class="post-shop">${escapeHTML(CONFIG.SHOP_NAME)} <span class="owner-badge">SHOP</span></div>
        <div class="post-meta">${escapeHTML(post.date)} &middot; ${escapeHTML(post.time)}</div>
      </div>
      ${isOwnerViewer ? `<button class="icon-btn post-delete-btn" data-action="delete-post" aria-label="Delete this post" style="border-color:var(--watermelon-light);color:var(--watermelon-dark);"><i class="fa-solid fa-trash-can" aria-hidden="true"></i></button>` : ""}
    </div>
    <div class="post-img-wrap">
      ${post.category ? `<span class="post-cat">${escapeHTML(post.category)}</span>` : ""}
      <img src="${post.imageData}" alt="${escapeHTML(post.caption || "Product photo")}" loading="lazy">
    </div>
    <div class="post-body">
      <p class="post-caption">${escapeHTML(post.caption)}</p>
    </div>
    ${totalReactions > 0 ? `<div class="reaction-summary">
      <div class="reaction-pills">${topTypes.map(t => `<span class="reaction-pill" aria-hidden="true">${REACTIONS[t].emoji}</span>`).join("")}</div>
      <span>${totalReactions}</span>
    </div>` : ""}
    <div class="post-actions">
      <div class="action-wrap">
        <button class="action-btn react-btn ${myReaction ? "liked" : ""}" data-action="react-toggle" aria-label="Like or react to this post" style="${myReaction ? "color:" + REACTIONS[myReaction.type].color + ";" : ""}">
          ${myReaction ? `<span aria-hidden="true">${REACTIONS[myReaction.type].emoji}</span>` : `<i class="fa-regular fa-heart" aria-hidden="true"></i>`} ${myReaction ? REACTIONS[myReaction.type].label : "Like"}
        </button>
      </div>
      <a class="action-btn" href="tel:${CONFIG.SHOP_PHONE}" aria-label="Call the shop">
        <i class="fa-solid fa-phone" aria-hidden="true"></i>
        Call
      </a>
      <button class="action-btn whatsapp-action" data-action="whatsapp-chat" data-caption="${escapeHTML(post.caption || "")}" aria-label="Message the shop on WhatsApp about this product">
        <i class="fa-brands fa-whatsapp" aria-hidden="true"></i>
        Chat
      </button>
      <button class="action-btn" data-action="share" aria-label="Share this post">
        <i class="fa-solid fa-share-nodes" aria-hidden="true"></i>
        Share
      </button>
    </div>
    <div class="reaction-picker hidden" data-picker>
      ${Object.entries(REACTIONS).map(([type, r]) => `<button type="button" data-react-type="${type}" aria-label="React with ${r.label}"><span aria-hidden="true">${r.emoji}</span></button>`).join("")}
    </div>
  </article>`;
}

function attachFeedEventListeners() {
  $all(".post-card").forEach(card => {
    const postId = card.dataset.postId;
    const reactBtn = card.querySelector('[data-action="react-toggle"]');
    const picker = card.querySelector("[data-picker]");
    reactBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const isOpen = !picker.classList.contains("hidden");
      $all(".reaction-picker").forEach(p => p.classList.add("hidden"));
      if (!isOpen) picker.classList.remove("hidden");
    });
    picker.querySelectorAll("button[data-react-type]").forEach(btn => {
      btn.addEventListener("click", () => {
        toggleReaction(postId, btn.dataset.reactType);
        picker.classList.add("hidden");
      });
    });
    const waBtn = card.querySelector('[data-action="whatsapp-chat"]');
    waBtn.addEventListener("click", () => {
      const caption = waBtn.dataset.caption;
      const context = caption ? ("I'm interested in: " + caption) : "";
      openWhatsAppChat(context);
    });
    const shareBtn = card.querySelector('[data-action="share"]');
    shareBtn.addEventListener("click", async () => {
      const post = STATE.posts.find(p => p.postId === postId);
      const shareText = (post && post.caption) ? post.caption : CONFIG.SHOP_NAME;
      if (navigator.share) {
        try { await navigator.share({ title: CONFIG.SHOP_NAME, text: shareText }); }
        catch (e) { /* user cancelled - nothing to do */ }
      } else {
        toast("Sharing isn't supported on this browser.");
      }
    });
    const deleteBtn = card.querySelector('[data-action="delete-post"]');
    if (deleteBtn) deleteBtn.addEventListener("click", () => confirmDeletePost(postId));
  });
}

function confirmDeletePost(postId) {
  openModal("Delete this post?", `
    <p style="font-size:14px;">This removes the post from the shop feed for everyone once you publish.</p>
    <div style="display:flex;gap:10px;margin-top:16px;">
      <button class="btn btn-outline btn-block" id="cancelDeletePost">Cancel</button>
      <button class="btn btn-danger btn-block" id="confirmDeletePost">Delete</button>
    </div>`, (body) => {
    body.querySelector("#cancelDeletePost").addEventListener("click", closeModal);
    body.querySelector("#confirmDeletePost").addEventListener("click", async () => {
      closeModal();
      await deletePost(postId);
      const canAutoPublish = githubSourceIsComplete(GH_SOURCE) && !!getGithubToken();
      toast(canAutoPublish ? "Post deleted - syncing to everyone now." : "Post deleted locally - add your publish token to sync it live.");
    });
  });
}

/* ---------------------------------------------------------------------
   Rendering: activity (customer's own reaction history)
   --------------------------------------------------------------------- */
async function renderActivity() {
  const wrap = $("#activityList");
  const reactions = await dbGetAll("reactions");
  const actorId = STATE.customer ? STATE.customer.id : "guest";
  const mine = reactions
    .filter(r => r.actorId === actorId)
    .map(r => ({ emoji: REACTIONS[r.type] ? REACTIONS[r.type].emoji : "\u2764\ufe0f", text: "You reacted to a post", at: r.createdAt }))
    .sort((a, b) => new Date(b.at) - new Date(a.at));
  if (!mine.length) {
    wrap.innerHTML = `<div class="empty-state"><h3>No activity yet</h3><p>Your likes will show up here.</p></div>`;
    return;
  }
  wrap.innerHTML = mine.map(a => `
    <div class="card" style="margin-bottom:10px;padding:14px;display:flex;gap:12px;align-items:flex-start;">
      <span style="font-size:16px;margin-top:2px;" aria-hidden="true">${a.emoji}</span>
      <div>
        <p style="margin:0;font-size:13.5px;">${escapeHTML(a.text)}</p>
        <p style="margin:4px 0 0;font-size:11px;color:var(--ink-soft);">${escapeHTML(relativeOrTime(a.at))}</p>
      </div>
    </div>`).join("");
}

/* ---------------------------------------------------------------------
   Modal helper
   --------------------------------------------------------------------- */
function openModal(titleText, bodyHtml, onMount) {
  const host = $("#modalHost");
  host.innerHTML = `
    <div class="modal-overlay" id="activeModalOverlay">
      <div class="modal-sheet" role="dialog" aria-modal="true" aria-label="${escapeHTML(titleText)}">
        <div class="modal-title"><h3>${escapeHTML(titleText)}</h3>
          <button class="close-x" id="modalCloseBtn" aria-label="Close">
            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
          </button>
        </div>
        <div id="modalBody">${bodyHtml}</div>
      </div>
    </div>`;
  $("#modalCloseBtn").addEventListener("click", closeModal);
  $("#activeModalOverlay").addEventListener("click", (e) => { if (e.target.id === "activeModalOverlay") closeModal(); });
  if (onMount) onMount($("#modalBody"));
}
function closeModal() { $("#modalHost").innerHTML = ""; }

/* ---------------------------------------------------------------------
   Event wiring
   --------------------------------------------------------------------- */
function initEventHandlers() {
  $("#btnContinueCustomer").addEventListener("click", () => showScreenGroup("customer-login"));
  $("#btnGoOwnerLogin").addEventListener("click", () => showScreenGroup("owner-login"));
  $("#backFromCustomerLogin").addEventListener("click", () => showScreenGroup("entry"));
  $("#backFromOwnerLogin").addEventListener("click", () => showScreenGroup("entry"));

  $("#formCustomerLogin").addEventListener("submit", (e) => {
    e.preventDefault();
    const mobile = $("#custMobile").value.trim();
    const name = sanitizeText($("#custName").value, 40);
    const errEl = $("#custMobileError");
    if (!validateMobile(mobile)) {
      errEl.textContent = "Enter a valid 10-digit mobile number.";
      errEl.classList.remove("hidden");
      return;
    }
    errEl.classList.add("hidden");
    loginCustomer(mobile, name || "Guest");
    toast("Welcome, " + (name || "Guest") + "!");
  });

  $("#formOwnerLogin").addEventListener("submit", (e) => {
    e.preventDefault();
    const u = $("#ownerUser").value.trim();
    const p = $("#ownerPass").value;
    const ok = loginOwner(u, p);
    const errEl = $("#ownerLoginError");
    if (!ok) {
      errEl.textContent = "Incorrect username or password.";
      errEl.classList.remove("hidden");
    } else {
      errEl.classList.add("hidden");
      toast("Welcome back, " + CONFIG.OWNER_NAME);
    }
  });

  $("#toggleOwnerPass").addEventListener("click", () => {
    const input = $("#ownerPass");
    const btn = $("#toggleOwnerPass");
    const icon = btn.querySelector("i");
    const nowVisible = input.type === "password";
    input.type = nowVisible ? "text" : "password";
    icon.className = nowVisible ? "fa-solid fa-eye-slash" : "fa-solid fa-eye";
    btn.setAttribute("aria-label", nowVisible ? "Hide password" : "Show password");
    btn.setAttribute("aria-pressed", nowVisible ? "true" : "false");
    input.focus();
    try {
      const pos = input.value.length;
      input.setSelectionRange(pos, pos);
    } catch (err) { /* not all input types support selection range */ }
  });

  const toggleGhToken = $("#toggleGhToken");
  if (toggleGhToken) {
    toggleGhToken.addEventListener("click", () => {
      const input = $("#ghToken");
      const icon = toggleGhToken.querySelector("i");
      const nowVisible = input.type === "password";
      input.type = nowVisible ? "text" : "password";
      icon.className = nowVisible ? "fa-solid fa-eye-slash" : "fa-solid fa-eye";
      toggleGhToken.setAttribute("aria-pressed", nowVisible ? "true" : "false");
    });
  }

  $all(".nav-item").forEach(btn => btn.addEventListener("click", () => navigateTo(btn.dataset.screen)));

  $("#btnThemeToggle").addEventListener("click", toggleTheme);

  $("#cameraInput").addEventListener("change", handleImageSelect);
  $("#galleryInput").addEventListener("change", handleImageSelect);
  $("#postCaption").addEventListener("input", () => {
    $("#captionCount").textContent = $("#postCaption").value.length;
  });
  $("#formCreatePost").addEventListener("submit", handleCreatePostSubmit);

  const formGithubConfig = $("#formGithubConfig");
  if (formGithubConfig) {
    formGithubConfig.addEventListener("submit", (e) => {
      e.preventDefault();
      setGithubToken($("#ghToken").value.trim());
      toast("Publish token saved on this device.");
      renderPublishPanel();
    });
  }
  const btnPublishNow = $("#btnPublishNow");
  if (btnPublishNow) btnPublishNow.addEventListener("click", () => publishToGithub());

  const btnProfileWhatsapp = $("#btnProfileWhatsapp");
  if (btnProfileWhatsapp) btnProfileWhatsapp.addEventListener("click", () => openWhatsAppChat());

  $("#toggleDarkMode").addEventListener("click", toggleTheme);
  $("#btnInstallApp").addEventListener("click", triggerInstall);
  $("#btnLogout").addEventListener("click", () => {
    openModal("Log out?", `
      <p style="font-size:14px;">You'll need to log in again to access your account. Saved posts stay on this device.</p>
      <div style="display:flex;gap:10px;margin-top:16px;">
        <button class="btn btn-outline btn-block" id="cancelLogout">Cancel</button>
        <button class="btn btn-danger btn-block" id="confirmLogout">Log out</button>
      </div>`, (body) => {
      body.querySelector("#cancelLogout").addEventListener("click", closeModal);
      body.querySelector("#confirmLogout").addEventListener("click", () => { closeModal(); logout(); });
    });
  });

  window.addEventListener("online", updateOfflineBanner);
  window.addEventListener("offline", updateOfflineBanner);
}

async function handleImageSelect(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const dataUrl = await compressImage(file);
    const approxBytes = Math.round((dataUrl.length * 3) / 4);
    $("#createImgPreview").src = dataUrl;
    $("#createImgPreview").classList.remove("hidden");
    $("#createImgPlaceholder").classList.add("hidden");
    STATE._pendingImageData = dataUrl;
    const hint = $("#imageSizeHint");
    if (approxBytes > CONFIG.MAX_IMAGE_BYTES) {
      hint.textContent = "This image is large (~" + Math.round(approxBytes / 1024) + "KB) even after compression - it may slow things down on this device.";
      hint.style.color = "var(--watermelon-dark)";
    } else {
      hint.textContent = "Image ready (~" + Math.round(approxBytes / 1024) + "KB).";
      hint.style.color = "var(--ink-soft)";
    }
  } catch (err) {
    toast(err.message || "Couldn't process that image.");
  }
}

async function handleCreatePostSubmit(e) {
  e.preventDefault();
  if (!STATE._pendingImageData) { toast("Please add a product photo first."); return; }
  const caption = $("#postCaption").value;
  const category = $("#postCategory").value;
  const btn = $("#btnPublishPost");
  btn.disabled = true; btn.textContent = "Posting…";
  try {
    await createPost({ imageData: STATE._pendingImageData, caption, category });
    const canAutoPublish = githubSourceIsComplete(GH_SOURCE) && !!getGithubToken();
    toast(canAutoPublish ? "Posted! Syncing to everyone now." : "Posted locally - add your publish token to sync it live.");
    $("#formCreatePost").reset();
    $("#createImgPreview").classList.add("hidden");
    $("#createImgPlaceholder").classList.remove("hidden");
    $("#captionCount").textContent = "0";
    $("#imageSizeHint").textContent = "";
    STATE._pendingImageData = null;
    navigateTo("home");
  } catch (err) {
    toast("Couldn't create post: " + err.message);
  } finally {
    btn.disabled = false; btn.textContent = "Post to Shop";
  }
}

function toggleTheme() {
  STATE.theme = STATE.theme === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", STATE.theme);
  localStorage.setItem("rr_theme", STATE.theme);
  const toggleEl = $("#toggleDarkMode");
  if (toggleEl) { toggleEl.classList.toggle("on", STATE.theme === "dark"); toggleEl.setAttribute("aria-pressed", STATE.theme === "dark"); }
}

function updateOfflineBanner() {
  $("#offlineBanner").classList.toggle("hidden", navigator.onLine);
}

/* ---------------------------------------------------------------------
   Boot
   --------------------------------------------------------------------- */
async function init() {
  const savedTheme = localStorage.getItem("rr_theme");
  if (savedTheme === "dark") { STATE.theme = "dark"; document.documentElement.setAttribute("data-theme", "dark"); }

  STATE.lastPublishedAt = localStorage.getItem("rr_last_published_at");

  try {
    STATE.db = await openDB();
  } catch (e) {
    toast("Local storage isn't available in this browser - some features may not work.");
  }

  initInstallPrompt();
  initEventHandlers();
  updateOfflineBanner();
  restoreSession();
}

document.addEventListener("DOMContentLoaded", init);
