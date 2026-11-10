# live_rooms.py - TrekSOS group rooms + live location tracking API
#
# Features covered: (3) group room with a 4-digit code, (4) live location
# tracking of group members.
#
# Rooms live in memory (a trek is a short-lived session, so no DB table is
# needed). Clients push their GPS fix every few seconds and poll the member
# list. Everything is plain HTTP/JSON, so it works with the existing Flask
# server and needs no extra packages.
#
# Hook-up in server.py:
#     from live_rooms import live_bp
#     app.register_blueprint(live_bp)

import math
import secrets
import threading
import time

from flask import Blueprint, jsonify, request

live_bp = Blueprint("live_rooms", __name__)

# ---------------------------------------------------------------- settings
MAX_ROOMS = 500
MAX_MEMBERS = 20
ROOM_IDLE_TTL = 12 * 3600      # drop a room after 12 h with no activity
ONLINE_WITHIN = 20             # seconds since last fix -> "online"
STALE_WITHIN = 120             # seconds since last fix -> "stale", then "offline"
COLORS = ["#38bdf8", "#10b981", "#f59e0b", "#a855f7", "#ec4899",
          "#14b8a6", "#f97316", "#84cc16", "#6366f1", "#ef4444"]

_rooms = {}                    # code -> room dict
_lock = threading.Lock()


# ----------------------------------------------------------------- helpers
def _now():
    return time.time()


def _clean(text, limit, default=""):
    text = (text or "").strip() if isinstance(text, str) else ""
    return text[:limit] or default


def _haversine_m(lat1, lng1, lat2, lng2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _number(value, lo, hi):
    """Return float(value) if it is a finite number inside [lo, hi], else None."""
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(value) or value < lo or value > hi:
        return None
    return value


def _cleanup_locked():
    cutoff = _now() - ROOM_IDLE_TTL
    for code in [c for c, r in _rooms.items() if r["last_activity"] < cutoff]:
        del _rooms[code]


def _new_code_locked():
    for _ in range(200):
        code = str(secrets.randbelow(9000) + 1000)   # 1000-9999
        if code not in _rooms:
            return code
    return None


def _new_member_locked(room, name, role, is_leader=False):
    member = {
        "id": secrets.token_hex(4),
        "token": secrets.token_urlsafe(16),
        "name": name,
        "role": role,
        "color": COLORS[len(room["members"]) % len(COLORS)],
        "is_leader": is_leader,
        "lat": None, "lng": None, "accuracy": None, "battery": None,
        "last_seen": None,       # last GPS fix
        "joined_at": _now(),
        "sos": False,
        "sos_at": None,
    }
    room["members"][member["id"]] = member
    room["last_activity"] = _now()
    return member


def _public_member(m, now):
    age = None if m["last_seen"] is None else now - m["last_seen"]
    if age is None:
        status = "no-fix"
    elif age <= ONLINE_WITHIN:
        status = "online"
    elif age <= STALE_WITHIN:
        status = "stale"
    else:
        status = "offline"
    return {
        "id": m["id"], "name": m["name"], "role": m["role"], "color": m["color"],
        "is_leader": m["is_leader"], "lat": m["lat"], "lng": m["lng"],
        "accuracy": m["accuracy"], "battery": m["battery"],
        "seconds_since_fix": None if age is None else round(age, 1),
        "status": status, "sos": m["sos"], "sos_at": m["sos_at"],
    }


def _room_snapshot_locked(room):
    now = _now()
    members = [_public_member(m, now) for m in room["members"].values()]
    # distance of every member to the leader (metres), when both have a fix
    leader = next((m for m in members if m["is_leader"]), None)
    for m in members:
        m["distance_to_leader_m"] = None
        if (leader and leader["lat"] is not None and m["lat"] is not None
                and m["id"] != leader["id"]):
            m["distance_to_leader_m"] = round(
                _haversine_m(leader["lat"], leader["lng"], m["lat"], m["lng"]))
    return {"code": room["code"], "name": room["name"],
            "created_at": room["created_at"], "server_time": now,
            "members": members}


def _json_body():
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def _error(message, status=400):
    return jsonify({"status": "error", "message": message}), status


def _get_member_locked(code, member_id, token):
    """Return (room, member) when code/member/token all match, else (None, None)."""
    room = _rooms.get(code)
    member = room["members"].get(member_id) if room else None
    if not member or not isinstance(token, str) \
            or not secrets.compare_digest(member["token"], token):
        return None, None
    return room, member


# --------------------------------------------------------------------- CORS
# Lets index.html opened straight from disk (file://) talk to the server too.
@live_bp.after_request
def _cors(resp):
    if request.path.startswith("/api/rooms"):
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        resp.headers["Cache-Control"] = "no-store"
    return resp


@live_bp.route("/api/rooms/<path:_any>", methods=["OPTIONS"])
@live_bp.route("/api/rooms", methods=["OPTIONS"])
def _preflight(_any=None):
    return ("", 204)


# ---------------------------------------------------------------- endpoints
@live_bp.route("/api/rooms/create", methods=["POST"])
def create_room():
    body = _json_body()
    name = _clean(body.get("user"), 40, "Leader")
    role = _clean(body.get("role"), 30, "Expedition Leader")
    room_name = _clean(body.get("room_name"), 60, "TrekSOS Squad")
    with _lock:
        _cleanup_locked()
        if len(_rooms) >= MAX_ROOMS:
            return _error("Server is full, try again later.", 503)
        code = _new_code_locked()
        if code is None:
            return _error("Could not allocate a room code.", 503)
        room = {"code": code, "name": room_name, "created_at": _now(),
                "last_activity": _now(), "members": {}}
        _rooms[code] = room
        me = _new_member_locked(room, name, role, is_leader=True)
        snap = _room_snapshot_locked(room)
    return jsonify({"status": "success", "code": code, "member_id": me["id"],
                    "token": me["token"], "room": snap})


@live_bp.route("/api/rooms/join", methods=["POST"])
def join_room():
    body = _json_body()
    code = _clean(str(body.get("code", "")), 4)
    if not (len(code) == 4 and code.isdigit()):
        return _error("Room key must be exactly 4 digits.")
    name = _clean(body.get("user"), 40, "Trekker")
    role = _clean(body.get("role"), 30, "Explorer")
    with _lock:
        _cleanup_locked()
        room = _rooms.get(code)
        if not room:
            return _error("No active room with this key.", 404)
        # Re-join after a page refresh: same device sends its old ids back.
        old = room["members"].get(str(body.get("member_id", "")))
        if old and isinstance(body.get("token"), str) \
                and secrets.compare_digest(old["token"], body["token"]):
            me = old
            room["last_activity"] = _now()
        else:
            if len(room["members"]) >= MAX_MEMBERS:
                return _error("This room is full.", 409)
            me = _new_member_locked(room, name, role)
        snap = _room_snapshot_locked(room)
    return jsonify({"status": "success", "code": code, "member_id": me["id"],
                    "token": me["token"], "room": snap})


@live_bp.route("/api/rooms/<code>/location", methods=["POST"])
def push_location(code):
    body = _json_body()
    lat = _number(body.get("lat"), -90, 90)
    lng = _number(body.get("lng"), -180, 180)
    if lat is None or lng is None:
        return _error("lat/lng missing or out of range.")
    acc = _number(body.get("accuracy"), 0, 100000)
    battery = _number(body.get("battery"), 0, 100)
    with _lock:
        room, me = _get_member_locked(code, str(body.get("member_id", "")), body.get("token"))
        if not me:
            return _error("Unknown member or room expired. Please re-join.", 403)
        me.update(lat=lat, lng=lng, accuracy=acc,
                  battery=None if battery is None else round(battery),
                  last_seen=_now())
        room["last_activity"] = _now()
        snap = _room_snapshot_locked(room)
    return jsonify({"status": "success", "room": snap})


@live_bp.route("/api/rooms/<code>/members", methods=["GET"])
def list_members(code):
    # Anyone who knows the 4-digit key can read the room (same trust model as
    # joining it). Member tokens are never included.
    with _lock:
        room = _rooms.get(code)
        if not room:
            return _error("Room not found or expired.", 404)
        snap = _room_snapshot_locked(room)
    return jsonify({"status": "success", "room": snap})


@live_bp.route("/api/rooms/<code>/sos", methods=["POST"])
def set_sos(code):
    body = _json_body()
    with _lock:
        room, me = _get_member_locked(code, str(body.get("member_id", "")), body.get("token"))
        if not me:
            return _error("Unknown member or room expired. Please re-join.", 403)
        me["sos"] = bool(body.get("active", True))
        me["sos_at"] = _now() if me["sos"] else None
        lat, lng = _number(body.get("lat"), -90, 90), _number(body.get("lng"), -180, 180)
        if me["sos"] and lat is not None and lng is not None:
            me.update(lat=lat, lng=lng, last_seen=_now())
        room["last_activity"] = _now()
        snap = _room_snapshot_locked(room)
    return jsonify({"status": "success", "room": snap})


@live_bp.route("/api/rooms/<code>/leave", methods=["POST"])
def leave_room(code):
    body = _json_body()
    with _lock:
        room, me = _get_member_locked(code, str(body.get("member_id", "")), body.get("token"))
        if not me:
            return jsonify({"status": "success"})      # already gone: fine
        del room["members"][me["id"]]
        if not room["members"]:
            del _rooms[code]
        elif me["is_leader"]:
            # hand leadership to the longest-standing member
            nxt = min(room["members"].values(), key=lambda m: m["joined_at"])
            nxt["is_leader"] = True
    return jsonify({"status": "success"})
