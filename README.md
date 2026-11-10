# TrekSOS - Mountain Navigation & Hiking Trails Hub

[![License: MIT](https://img.shields.io/badge/License-MIT-red.svg)](https://opensource.org/licenses/MIT)
[![Leaflet](https://img.shields.io/badge/Leaflet-v1.9.4-brightgreen.svg)](https://leafletjs.com/)
[![Database](https://img.shields.io/badge/Database-IndexedDB%20v2.4-blue.svg)](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)

An advanced offline-capable mountain navigation and hiking trails web platform built for high-altitude expeditions, alpine safety, and real-time mountain route tracking.

---

## 🏔️ Key Features

### 1. Indian Himalayan Trails Catalogue (Kaggle Dataset Integrated)
- Built-in database of **16 famous Indian trekking routes** across Uttarakhand, Himachal Pradesh, Ladakh, Sikkim, and West Bengal:
  - Kedarkantha Winter Summit Trek
  - Hampta Pass & Chandratal Trek
  - Roopkund Mystery Lake Trek
  - Borasu Pass Alpine Expedition
  - Chadar Frozen River Trek (Zanskar)
  - Valley of Flowers & Hemkund
  - Beas Kund Glacial Basin
  - Pin Parvati Pass Traverse
  - Har Ki Dun Heritage Valley
  - Markha Valley High Plateau
  - Goechala Kanchenjunga View
  - Sandakphu & Singalila Ridge
  - Brahmatal Frozen Winter Lake
  - Kuari Pass Lord Curzon Trail
  - Buran Ghati Pass Expedition
  - Triund & Dhauladhar Snowline

- **Detailed Trail Information**:
  - Trek Name & State/Region
  - Base Camp & Starting Trailhead
  - Maximum Altitude (meters and feet)
  - Difficulty Rating (Easy, Moderate, Difficult)
  - Trek Duration & Distance (km)
  - Best Season & Estimated Cost (₹)
  - Permit Requirements & Accommodation Types

### 2. Interactive Mountain Pathways & Waypoint Markers
- Multi-camp waypoints surveyed from basecamp through intermediate valleys to the summit col.
- Glowing high-contrast crimson route polylines with animated white GPS tracker overlays.
- Clickable camp pins displaying daily altitude, waypoints, and campsite notes.
- **🌐 All India Trails Overview**: Visualize all 16 Himalayan routes simultaneously across the country.

### 3. Persistent User Authentication & Offline Database (IndexedDB)
- **TrekSOS Production Database** (`TrekSOS_Production_DB` v2) running on browser IndexedDB.
- SHA-256 hashed password authentication for mountain credentials.
- Stores user profiles, emergency contacts, blood groups, saved trails, and SOS dispatch events.
- Real-time Database Records Inspector modal with JSON export capability.

### 4. Multi-Layer Mountain Topography (No API Keys Needed)
- **Esri World Topographic**: Contours, ridges, elevation detail, and mountain peaks.
- **OpenStreetMap Standard**: Roads, base towns, and established mountain paths.
- **Esri World Imagery (Satellite)**: Aerial photographic terrain views.
- **Carto Dark**: High-contrast night navigation theme.

### 5. Expedition Squad Tracking & Emergency SOS
- Real-time simulation of squad members (Lead, Active, Behind, Out-of-Signal).
- Pulse-animated Emergency SOS broadcasting with offline log recording.

### 6. Live Squad Rooms & Member Tracking (4-digit key)
- **Create / join a room** from the *Room* window or the journey wizard (Step 1). The server hands out a unique 4-digit key (`live_rooms.py`).
- **Live GPS tracking**: every member's browser sends its GPS fix every ~3 s; everyone sees teammates move on the map with name labels, breadcrumb trails, battery, accuracy and distance from the leader.
- **Status & warnings**: online / weak signal / offline, a "behind the leader" warning (>300 m), and SOS from any member is broadcast to the whole room.
- **Rejoin after refresh**, leader hand-over when the leader leaves, rooms expire after 12 h idle.
- **Demo mode**: *Add 2 demo teammates* in the Room window simulates trekkers so tracking can be shown on a single device.
- Files: `live_rooms.py` (Flask API), `live_tracking.js` (map + UI). API: `POST /api/rooms/create|join`, `POST /api/rooms/<key>/location|sos|leave`, `GET /api/rooms/<key>/members`.

**Using it on several devices:** run `set TREKSOS_HOST=0.0.0.0` (PowerShell: `$env:TREKSOS_HOST="0.0.0.0"`) before `python server.py` and open `http://<your-laptop-ip>:5000` on the other devices. Browsers only allow GPS on `https://` or `localhost`, so for real phone GPS expose the server through an HTTPS tunnel (e.g. `cloudflared tunnel --url http://localhost:5000` or ngrok).

---

## 🚀 Getting Started

Simply open `index.html` or `sos2.html` directly in any modern web browser:

```bash
# Clone the repository
git clone https://github.com/Sritama-Codes/TrekSOS.git

# Navigate into project directory
cd TrekSOS

# Open in browser (Windows PowerShell)
Start-Process sos2.html
# or
Start-Process index.html
```

---

## 📊 Dataset Files Included
- `shwetayd_indian_trekking_routes_dataset.csv`
- `hiking_trails_dataset.csv`

---

## 📜 License
This project is open-source and available under the [MIT License](LICENSE).
