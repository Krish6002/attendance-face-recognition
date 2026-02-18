const API_BASE = "http://localhost:5002/api";

document.addEventListener("DOMContentLoaded", () => {
  initTabs();
  initDetectTab();
  initAddPersonTab();
});

/* =========================
   TAB SWITCHING
========================= */
function initTabs() {
  const btns = document.querySelectorAll(".tab-btn");
  btns.forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll(".tab-btn, .tab-content").forEach(el => el.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
    };
  });
}

/* =========================
   DETECT TAB
========================= */
function initDetectTab() {
  const detectImage   = document.getElementById("detectImage");
  const detectCanvas  = document.getElementById("detectCanvas");
  const detectResults = document.getElementById("detectResults");
  const uploadBtn     = document.getElementById("uploadImageBtn");
  const fileInput     = document.getElementById("detectFileInput");
  const openCameraBtn = document.getElementById("openCameraBtn");
  const cameraArea    = document.getElementById("cameraArea");
  const cameraVideo   = document.getElementById("cameraVideo");
  const captureBtn    = document.getElementById("captureBtn");
  const closeCameraBtn = document.getElementById("closeCameraBtn");

  let cameraStream = null;

  function resetDetectUI() {
    detectResults.innerHTML = "Processing...";
    const ctx = detectCanvas.getContext("2d");
    ctx.clearRect(0, 0, detectCanvas.width, detectCanvas.height);
  }

  // UPLOAD
  uploadBtn.onclick = () => fileInput.click();
  fileInput.onchange = () => {
    const file = fileInput.files[0];
    if (!file) return;
    resetDetectUI();
    detectImage.src = URL.createObjectURL(file);
    // FIX: wait for image to fully load before running detection
    // so clientWidth/clientHeight are correct for canvas sizing
    detectImage.onload = () => runDetect(file);
  };

  // CAMERA
  openCameraBtn.onclick = async () => {
    cameraArea.classList.remove("hidden");
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({ video: true });
      cameraVideo.srcObject = cameraStream;
      cameraVideo.play();
    } catch (err) {
      alert("Camera access denied.");
    }
  };

  captureBtn.onclick = () => {
    const canvas = document.createElement("canvas");
    canvas.width  = cameraVideo.videoWidth;
    canvas.height = cameraVideo.videoHeight;
    canvas.getContext("2d").drawImage(cameraVideo, 0, 0);
    canvas.toBlob((blob) => {
      resetDetectUI();
      detectImage.src = URL.createObjectURL(blob);
      // FIX: wait for image to load before running detect
      detectImage.onload = () => runDetect(blob);
      stopCamera();
      cameraArea.classList.add("hidden");
    }, "image/jpeg");
  };

  function stopCamera() {
    if (cameraStream) {
      cameraStream.getTracks().forEach(t => t.stop());
      cameraStream = null;
    }
  }

  closeCameraBtn.onclick = () => {
    stopCamera();
    cameraArea.classList.add("hidden");
  };

  async function runDetect(fileOrBlob) {
    detectResults.innerHTML = "Checking with AWS Rekognition...";

    const formData = new FormData();
    formData.append("photo", fileOrBlob);

    try {
      const response = await fetch(`${API_BASE}/detect`, {
        method: "POST",
        body: formData
      });

      const json = await response.json();

      if (json.error) {
        detectResults.innerHTML = `<p style="color:red">Error: ${json.error}</p>`;
        return;
      }

      // FIX: pass the scoped canvas/image/results elements directly
      drawResults(json, detectCanvas, detectImage, detectResults);

    } catch (err) {
      console.error("Connection Error:", err);
      detectResults.innerHTML = `<p style="color:red">Server unreachable. Is your Node server running on 5002?</p>`;
    }
  }
}

/* =========================
   DRAW BOUNDING BOXES
========================= */
function drawResults(json, canvas, img, resultsDiv) {
  const results = json.results || [];
  resultsDiv.innerHTML = "";

  if (results.length === 0) {
    resultsDiv.innerHTML = "<p>No faces found.</p>";
    return;
  }

  // Use getBoundingClientRect for pixel-perfect positioning
  const imgRect       = img.getBoundingClientRect();
  const containerRect = canvas.parentElement.getBoundingClientRect();

  // Size the canvas to exactly match the rendered image
  canvas.width  = imgRect.width;
  canvas.height = imgRect.height;

  // Position canvas over the image, relative to its container (handles padding/scroll correctly)
  canvas.style.left    = (imgRect.left - containerRect.left) + "px";
  canvas.style.top     = (imgRect.top  - containerRect.top)  + "px";
  canvas.style.padding = "0";

  const ctx = canvas.getContext("2d");

  results.forEach((item) => {
    const box = item.boundingBox;
    const x = box.Left   * canvas.width;
    const y = box.Top    * canvas.height;
    const w = box.Width  * canvas.width;
    const h = box.Height * canvas.height;

    const match   = item.match;
    const isKnown = match !== null;

    ctx.strokeStyle = isKnown ? "#00FF00" : "#FF0000";
    ctx.lineWidth   = 3;
    ctx.strokeRect(x, y, w, h);

    const p = document.createElement("p");
    p.className = "result-item";
    if (isKnown) {
      p.innerHTML = `✅ <b>Present:</b> ${match.name}<br><small>USN: ${match.usn} (${match.similarity.toFixed(1)}%)</small>`;
    } else {
      p.innerHTML = `❌ <b>Unknown Face</b>`;
    }
    resultsDiv.appendChild(p);
  });
}

/* =========================
   ADD PERSON TAB
========================= */
function initAddPersonTab() {
  const form   = document.getElementById("addPersonForm");
  const status = document.getElementById("addPersonStatus");

  if (!form) return; // guard for add-person.html standalone page

  form.onsubmit = async (e) => {
    e.preventDefault();
    status.style.color  = "";
    status.innerText    = "Registering... Please wait.";

    const formData = new FormData();
    formData.append("fullName", document.getElementById("fullName").value);
    // FIX: 'usn' field exists in index.html; guard for add-person.html which has no usn field
    const usnEl = document.getElementById("usn");
    if (usnEl) formData.append("usn", usnEl.value);

    const photos = document.getElementById("personImages").files;
    for (const f of photos) {
      formData.append("photos", f);
    }

    try {
      const res  = await fetch(`${API_BASE}/add-person`, { method: "POST", body: formData });
      const json = await res.json();

      if (json.error) {
        status.style.color = "red";
        status.innerText   = "Error: " + json.error;
      } else {
        status.style.color = "green";
        status.innerText   = json.message;
        form.reset();
      }
    } catch (err) {
      status.innerText = "Connection failed. Check server.";
    }
  };
}