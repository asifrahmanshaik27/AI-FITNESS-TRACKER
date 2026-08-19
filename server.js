require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { GoogleGenAI } = require("@google/genai");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SESSION_DAYS = 30;

const DATA_DIR = path.join(__dirname, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const DB_PATH = path.join(DATA_DIR, "ai-food-v3.db");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_login_at TEXT,
    previous_login_at TEXT,
    login_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS profiles (
    user_id INTEGER PRIMARY KEY,
    age INTEGER,
    sex TEXT,
    height_cm REAL,
    activity REAL DEFAULT 1.2,
    goal TEXT DEFAULT 'maintain',
    calorie_target REAL DEFAULT 0,
    protein_target REAL DEFAULT 0,
    fat_target REAL DEFAULT 0,
    carbs_target REAL DEFAULT 0,
    water_target_ml INTEGER DEFAULT 2500,
    bmr REAL DEFAULT 0,
    tdee REAL DEFAULT 0,
    bmi REAL DEFAULT 0,
    bmi_category TEXT DEFAULT '',
    updated_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS weight_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    entry_date TEXT NOT NULL,
    weight_kg REAL NOT NULL,
    note TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE(user_id, entry_date),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS body_measurements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    entry_date TEXT NOT NULL,
    body_fat REAL,
    waist_cm REAL,
    chest_cm REAL,
    arm_cm REAL,
    thigh_cm REAL,
    note TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE(user_id, entry_date),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS meals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    meal_date TEXT NOT NULL,
    meal_type TEXT NOT NULL,
    name TEXT NOT NULL,
    serving TEXT DEFAULT '1 serving',
    calories REAL NOT NULL DEFAULT 0,
    protein REAL NOT NULL DEFAULT 0,
    carbs REAL NOT NULL DEFAULT 0,
    fat REAL NOT NULL DEFAULT 0,
    image_path TEXT,
    ai_description TEXT,
    ai_confidence REAL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS water_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    entry_date TEXT NOT NULL,
    amount_ml INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_weights_user_date
    ON weight_entries(user_id, entry_date DESC);

CREATE INDEX IF NOT EXISTS idx_meals_user_date
    ON meals(user_id, meal_date DESC);

CREATE INDEX IF NOT EXISTS idx_body_user_date
    ON body_measurements(user_id, entry_date DESC);

CREATE INDEX IF NOT EXISTS idx_water_user_date
    ON water_entries(user_id, entry_date DESC);
`);

// V3 migration: older databases did not have a saved hydration target.
try { db.exec("ALTER TABLE profiles ADD COLUMN water_target_ml INTEGER DEFAULT 2500"); } catch (_) {}

const ai = process.env.GEMINI_API_KEY
    ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
    : null;

app.use(express.json({ limit: "15mb" }));
app.use(express.static(path.join(__dirname, "public")));

function now() {
    return new Date().toISOString();
}

function isDate(value) {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function todayFromRequest(req) {
    const value = req.query.date || req.body?.date;
    if (isDate(value)) return value;
    return new Date().toISOString().slice(0, 10);
}

function hashToken(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
}

function makePassword(password) {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(password, salt, 64).toString("hex");
    return { salt, hash };
}

function verifyPassword(password, salt, storedHash) {
    const hash = crypto.scryptSync(password, salt, 64).toString("hex");
    return crypto.timingSafeEqual(
        Buffer.from(hash, "hex"),
        Buffer.from(storedHash, "hex")
    );
}

function setSessionCookie(res, token) {
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    res.setHeader(
        "Set-Cookie",
        `session=${token}; HttpOnly; Path=/; Max-Age=${SESSION_DAYS * 86400}; SameSite=Lax${secure}`
    );
}

function clearSessionCookie(res) {
    res.setHeader(
        "Set-Cookie",
        "session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax"
    );
}

function readCookie(req, name) {
    const header = req.headers.cookie || "";
    const part = header
        .split(";")
        .map((item) => item.trim())
        .find((item) => item.startsWith(name + "="));
    return part ? decodeURIComponent(part.slice(name.length + 1)) : null;
}

function createSession(userId) {
    const token = crypto.randomBytes(32).toString("base64url");
    const tokenHash = hashToken(token);
    const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();

    db.prepare(`
        INSERT INTO sessions (user_id, token_hash, expires_at, created_at)
        VALUES (?, ?, ?, ?)
    `).run(userId, tokenHash, expires, now());

    return token;
}

function getUserFromRequest(req) {
    const token = readCookie(req, "session");
    if (!token) return null;

    const row = db.prepare(`
        SELECT u.*
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ?
    `).get(hashToken(token), now());

    return row || null;
}

function requireAuth(req, res, next) {
    const user = getUserFromRequest(req);
    if (!user) {
        return res.status(401).json({ error: "Please log in." });
    }
    req.user = user;
    next();
}

function sanitizeUser(user) {
    return {
        id: user.id,
        name: user.name,
        email: user.email,
        createdAt: user.created_at,
        lastLoginAt: user.last_login_at,
        previousLoginAt: user.previous_login_at,
        loginCount: user.login_count
    };
}

function getProfile(userId) {
    return db.prepare(`SELECT * FROM profiles WHERE user_id = ?`).get(userId) || null;
}

function calculateTargets({ age, sex, height, weight, activity, goal }) {
    age = Number(age);
    height = Number(height);
    weight = Number(weight);
    activity = Number(activity);

    if (![age, height, weight, activity].every(Number.isFinite)) {
        throw new Error("Age, height, weight and activity are required.");
    }
    if (age < 18 || age > 120) throw new Error("Age must be between 18 and 120.");
    if (height < 100 || height > 250) throw new Error("Height must be between 100 and 250 cm.");
    if (weight < 30 || weight > 300) throw new Error("Weight must be between 30 and 300 kg.");

    const bmr = sex === "female"
        ? 10 * weight + 6.25 * height - 5 * age - 161
        : 10 * weight + 6.25 * height - 5 * age + 5;

    const tdee = bmr * activity;
    let calories = goal === "loss" ? tdee - 300 : goal === "gain" ? tdee + 300 : tdee;

    const minimumCalories = sex === "female" ? 1200 : 1500;
    const calorieWarning = calories < minimumCalories;
    calories = Math.max(calories, minimumCalories);

    let proteinFactor = activity <= 1.2 ? 1.2
        : activity <= 1.375 ? 1.4
        : activity <= 1.55 ? 1.6
        : activity <= 1.725 ? 1.6
        : 1.8;

    if (goal === "loss") proteinFactor = Math.max(proteinFactor, 1.6);

    const protein = weight * proteinFactor;
    const fatCalories = calories * 0.25;
    const fat = fatCalories / 9;
    const carbs = Math.max(0, (calories - protein * 4 - fatCalories) / 4);
    const bmi = weight / Math.pow(height / 100, 2);
    const bmiCategory = bmi < 18.5 ? "Underweight"
        : bmi < 25 ? "Healthy range"
        : bmi < 30 ? "Overweight"
        : "Obesity range";

    return {
        age, sex, height_cm: height, weight_kg: weight, activity, goal,
        bmr: Math.round(bmr),
        tdee: Math.round(tdee),
        calorie_target: Math.round(calories),
        protein_target: Math.round(protein),
        fat_target: Math.round(fat),
        carbs_target: Math.round(carbs),
        bmi: Math.round(bmi * 10) / 10,
        bmi_category: bmiCategory,
        calorieWarning
    };
}

function getDashboard(userId, date) {
    const profile = getProfile(userId);

    const meals = db.prepare(`
        SELECT id, meal_date, meal_type, name, serving, calories, protein, carbs, fat,
               image_path, ai_description, ai_confidence, created_at
        FROM meals
        WHERE user_id = ? AND meal_date = ?
        ORDER BY created_at DESC
    `).all(userId, date);

    const weight = db.prepare(`
        SELECT * FROM weight_entries
        WHERE user_id = ? AND entry_date = ?
    `).get(userId, date) || null;

    const previousWeight = db.prepare(`
        SELECT * FROM weight_entries
        WHERE user_id = ? AND entry_date < ?
        ORDER BY entry_date DESC
        LIMIT 1
    `).get(userId, date) || null;

    const water = db.prepare(`
        SELECT COALESCE(SUM(amount_ml), 0) AS total
        FROM water_entries
        WHERE user_id = ? AND entry_date = ?
    `).get(userId, date);

    const waterEntries = db.prepare(`
        SELECT id, amount_ml, created_at
        FROM water_entries
        WHERE user_id = ? AND entry_date = ?
        ORDER BY created_at DESC
    `).all(userId, date);

    const totals = meals.reduce((sum, meal) => {
        sum.calories += Number(meal.calories) || 0;
        sum.protein += Number(meal.protein) || 0;
        sum.carbs += Number(meal.carbs) || 0;
        sum.fat += Number(meal.fat) || 0;
        return sum;
    }, { calories: 0, protein: 0, carbs: 0, fat: 0 });

    const recentWeights = db.prepare(`
        SELECT entry_date, weight_kg, note
        FROM weight_entries
        WHERE user_id = ?
        ORDER BY entry_date DESC
        LIMIT 30
    `).all(userId);

    const measurements = db.prepare(`
        SELECT entry_date, body_fat, waist_cm, chest_cm, arm_cm, thigh_cm, note
        FROM body_measurements
        WHERE user_id = ?
        ORDER BY entry_date DESC
        LIMIT 30
    `).all(userId);

    return {
        profile,
        meals,
        totals,
        weight,
        previousWeight,
        weightChange: weight && previousWeight
            ? Number((weight.weight_kg - previousWeight.weight_kg).toFixed(2))
            : null,
        waterMl: Number(water.total || 0),
        waterTargetMl: Number(profile?.water_target_ml || 2500),
        waterEntries,
        recentWeights,
        measurements
    };
}

function parseAndSaveImage(userId, dataUrl) {
    if (!dataUrl) return null;

    const match = String(dataUrl).match(
        /^data:(image\/(?:jpeg|jpg|png|webp));base64,(.+)$/i
    );
    if (!match) throw new Error("Invalid food image.");

    const mime = match[1].toLowerCase();
    const buffer = Buffer.from(match[2], "base64");

    if (buffer.length > 8 * 1024 * 1024) {
        throw new Error("Food image must be 8 MB or smaller.");
    }

    const extension = mime.includes("png")
        ? "png"
        : mime.includes("webp")
            ? "webp"
            : "jpg";

    const userDir = path.join(UPLOAD_DIR, String(userId));
    fs.mkdirSync(userDir, { recursive: true });

    const filename = `${crypto.randomUUID()}.${extension}`;
    const absolutePath = path.join(userDir, filename);
    fs.writeFileSync(absolutePath, buffer);

    return path.relative(DATA_DIR, absolutePath).replaceAll(path.sep, "/");
}

function deleteStoredImage(relativePath) {
    if (!relativePath) return;
    const absolute = path.resolve(DATA_DIR, relativePath);
    if (!absolute.startsWith(path.resolve(UPLOAD_DIR) + path.sep)) return;
    try { fs.unlinkSync(absolute); } catch {}
}

// ------------------------------------------------------------
// AUTH
// ------------------------------------------------------------

app.post("/api/auth/register", (req, res) => {
    try {
        const name = String(req.body.name || "").trim();
        const email = String(req.body.email || "").trim().toLowerCase();
        const password = String(req.body.password || "");

        if (name.length < 2) return res.status(400).json({ error: "Please enter your name." });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ error: "Please enter a valid email." });
        }
        if (password.length < 8) {
            return res.status(400).json({ error: "Password must be at least 8 characters." });
        }

        const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email);
        if (existing) return res.status(409).json({ error: "An account with that email already exists." });

        const { salt, hash } = makePassword(password);
        const createdAt = now();

        const result = db.prepare(`
            INSERT INTO users (name, email, password_hash, password_salt, created_at)
            VALUES (?, ?, ?, ?, ?)
        `).run(name, email, hash, salt, createdAt);

        const userId = Number(result.lastInsertRowid);

        db.prepare(`
            INSERT INTO profiles (user_id, water_target_ml, updated_at)
            VALUES (?, 2500, ?)
        `).run(userId, createdAt);

        // Creating an account also starts the user's first visit.
        db.prepare(`
            UPDATE users
            SET last_login_at = ?, login_count = 1
            WHERE id = ?
        `).run(createdAt, userId);

        const token = createSession(userId);
        setSessionCookie(res, token);

        res.json({
            user: sanitizeUser(db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId)),
            firstLogin: true
        });
    } catch (error) {
        console.error("Registration error:", error);
        res.status(500).json({ error: "Could not create your account." });
    }
});

app.post("/api/auth/login", (req, res) => {
    try {
        const email = String(req.body.email || "").trim().toLowerCase();
        const password = String(req.body.password || "");

        const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email);

        if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) {
            return res.status(401).json({ error: "Incorrect email or password." });
        }

        const loginTime = now();
        const previousLogin = user.last_login_at;

        db.prepare(`
            UPDATE users
            SET previous_login_at = ?, last_login_at = ?, login_count = login_count + 1
            WHERE id = ?
        `).run(previousLogin, loginTime, user.id);

        // Keep only the user's most recent active session set reasonably small.
        db.prepare(`DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?`).run(user.id, loginTime);

        const token = createSession(user.id);
        setSessionCookie(res, token);

        const freshUser = db.prepare(`SELECT * FROM users WHERE id = ?`).get(user.id);

        res.json({
            user: sanitizeUser(freshUser),
            firstLogin: !previousLogin
        });
    } catch (error) {
        console.error("Login error:", error);
        res.status(500).json({ error: "Could not log you in." });
    }
});

app.post("/api/auth/logout", (req, res) => {
    const token = readCookie(req, "session");
    if (token) {
        db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(hashToken(token));
    }
    clearSessionCookie(res);
    res.json({ ok: true });
});

app.get("/api/me", requireAuth, (req, res) => {
    res.json({
        user: sanitizeUser(req.user),
        profile: getProfile(req.user.id)
    });
});

// ------------------------------------------------------------
// PROFILE / BODY TRACKING
// ------------------------------------------------------------

app.put("/api/profile/age", requireAuth, (req, res) => {
    try {
        const age = Number(req.body.age);

        if (!Number.isInteger(age) || age < 18 || age > 120) {
            return res.status(400).json({
                error: "Age must be between 18 and 120."
            });
        }

        db.prepare(`
            UPDATE profiles
            SET age = ?, updated_at = ?
            WHERE user_id = ?
        `).run(
            age,
            now(),
            req.user.id
        );

        res.json({
            ok: true,
            profile: getProfile(req.user.id)
        });

    } catch (error) {
        console.error("Age save error:", error);

        res.status(500).json({
            error: "Could not save age."
        });
    }
});

app.post("/api/weights", requireAuth, (req, res) => {
    try {
        const date = String(req.body.date || "");
        const weight = Number(req.body.weight);
        const note = String(req.body.note || "").slice(0, 500);

        if (!isDate(date)) return res.status(400).json({ error: "Use a valid date." });
        if (!Number.isFinite(weight) || weight < 30 || weight > 300) {
            return res.status(400).json({ error: "Weight must be between 30 and 300 kg." });
        }

        db.prepare(`
            INSERT INTO weight_entries (user_id, entry_date, weight_kg, note, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(user_id, entry_date)
            DO UPDATE SET weight_kg = excluded.weight_kg, note = excluded.note
        `).run(req.user.id, date, weight, note, now());

        // Keep the current profile weight synchronized with the newest entry.
        const latest = db.prepare(`
            SELECT weight_kg FROM weight_entries
            WHERE user_id = ?
            ORDER BY entry_date DESC LIMIT 1
        `).get(req.user.id);

        if (latest) {
            const profile = getProfile(req.user.id);
            if (profile && profile.age && profile.height_cm) {
                try {
                    const calc = calculateTargets({
                        age: profile.age,
                        sex: profile.sex || "male",
                        height: profile.height_cm,
                        weight: latest.weight_kg,
                        activity: profile.activity || 1.2,
                        goal: profile.goal || "maintain"
                    });
                    db.prepare(`
                        UPDATE profiles
                        SET calorie_target=?, protein_target=?, fat_target=?, carbs_target=?,
                            bmr=?, tdee=?, bmi=?, bmi_category=?, updated_at=?
                        WHERE user_id=?
                    `).run(
                        calc.calorie_target, calc.protein_target, calc.fat_target, calc.carbs_target,
                        calc.bmr, calc.tdee, calc.bmi, calc.bmi_category, now(), req.user.id
                    );
                } catch {}
            }
        }

        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ error: "Could not save weight." });
    }
});

app.post("/api/body-measurements", requireAuth, (req, res) => {
    try {
        const date = String(req.body.date || "");
        if (!isDate(date)) return res.status(400).json({ error: "Use a valid date." });

        const fields = ["bodyFat", "waist", "chest", "arm", "thigh"];
        const values = fields.map((key) => {
            const value = req.body[key];
            if (value === "" || value === null || value === undefined) return null;
            const number = Number(value);
            if (!Number.isFinite(number) || number < 0 || number > 500) {
                throw new Error(`Invalid ${key} value.`);
            }
            return number;
        });

        db.prepare(`
            INSERT INTO body_measurements
                (user_id, entry_date, body_fat, waist_cm, chest_cm, arm_cm, thigh_cm, note, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, entry_date)
            DO UPDATE SET body_fat=excluded.body_fat, waist_cm=excluded.waist_cm,
                chest_cm=excluded.chest_cm, arm_cm=excluded.arm_cm,
                thigh_cm=excluded.thigh_cm, note=excluded.note
        `).run(
            req.user.id, date, ...values, String(req.body.note || "").slice(0, 500), now()
        );

        res.json({ ok: true });
    } catch (error) {
        res.status(400).json({ error: error.message || "Could not save measurements." });
    }
});

app.post("/api/water", requireAuth, (req, res) => {
    try {
        const date = String(req.body.date || "");
        const amount = Number(req.body.amountMl);
        if (!isDate(date)) return res.status(400).json({ error: "Use a valid date." });
        if (!Number.isInteger(amount) || amount < 1 || amount > 5000) {
            return res.status(400).json({ error: "Water amount must be between 1 and 5000 ml." });
        }

        db.prepare(`
            INSERT INTO water_entries (user_id, entry_date, amount_ml, created_at)
            VALUES (?, ?, ?, ?)
        `).run(req.user.id, date, amount, now());

        res.json({ ok: true });
    } catch {
        res.status(500).json({ error: "Could not save water." });
    }
});

app.delete("/api/water/:id", requireAuth, (req, res) => {
    try {
        const result = db.prepare(`DELETE FROM water_entries WHERE id = ? AND user_id = ?`).run(Number(req.params.id), req.user.id);
        if (!result.changes) return res.status(404).json({ error: "Water entry not found." });
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ error: "Could not remove water entry." });
    }
});

// ------------------------------------------------------------
// DASHBOARD / HISTORY
// ------------------------------------------------------------

app.get("/api/dashboard", requireAuth, (req, res) => {
    const date = todayFromRequest(req);
    res.json({
        user: sanitizeUser(req.user),
        date,
        ...getDashboard(req.user.id, date)
    });
});

app.get("/api/history", requireAuth, (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 60, 1), 365);

    const weights = db.prepare(`
        SELECT entry_date, weight_kg, note
        FROM weight_entries
        WHERE user_id = ?
        ORDER BY entry_date DESC
        LIMIT ?
    `).all(req.user.id, limit);

    const measurements = db.prepare(`
        SELECT entry_date, body_fat, waist_cm, chest_cm, arm_cm, thigh_cm, note
        FROM body_measurements
        WHERE user_id = ?
        ORDER BY entry_date DESC
        LIMIT ?
    `).all(req.user.id, limit);

    const meals = db.prepare(`
        SELECT meal_date,
               COUNT(*) AS meal_count,
               ROUND(SUM(calories), 1) AS calories,
               ROUND(SUM(protein), 1) AS protein,
               ROUND(SUM(carbs), 1) AS carbs,
               ROUND(SUM(fat), 1) AS fat
        FROM meals
        WHERE user_id = ?
        GROUP BY meal_date
        ORDER BY meal_date DESC
        LIMIT ?
    `).all(req.user.id, limit);

    res.json({ weights, measurements, meals });
});

// ------------------------------------------------------------
// MEALS
// ------------------------------------------------------------

app.post("/api/meals", requireAuth, (req, res) => {
    try {
        const date = String(req.body.date || "");
        const name = String(req.body.name || "").trim();
        const type = String(req.body.type || "Snack");
        const serving = String(req.body.serving || "1 serving").slice(0, 100);
        const calories = Number(req.body.calories);
        const protein = Number(req.body.protein);
        const carbs = Number(req.body.carbs);
        const fat = Number(req.body.fat);
        const description = String(req.body.description || "").slice(0, 1000);
        const confidence = req.body.confidence === "" ? null : Number(req.body.confidence);

        if (!isDate(date)) return res.status(400).json({ error: "Use a valid date." });
        if (!name || name.length > 200) return res.status(400).json({ error: "Food name is required." });
        if (!["Breakfast", "Lunch", "Dinner", "Snack"].includes(type)) {
            return res.status(400).json({ error: "Invalid meal type." });
        }
        for (const [label, value] of [["calories", calories], ["protein", protein], ["carbs", carbs], ["fat", fat]]) {
            if (!Number.isFinite(value) || value < 0) {
                return res.status(400).json({ error: `Invalid ${label}.` });
            }
        }

        let imagePath = null;
        if (req.body.image) {
            imagePath = parseAndSaveImage(req.user.id, req.body.image);
        }

        const result = db.prepare(`
            INSERT INTO meals
                (user_id, meal_date, meal_type, name, serving, calories, protein, carbs, fat,
                 image_path, ai_description, ai_confidence, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            req.user.id, date, type, name, serving, calories, protein, carbs, fat,
            imagePath, description, Number.isFinite(confidence) ? Math.max(0, Math.min(100, confidence)) : null, now()
        );

        res.json({ id: Number(result.lastInsertRowid) });
    } catch (error) {
        console.error("Meal save error:", error);
        res.status(400).json({ error: error.message || "Could not save meal." });
    }
});

app.delete("/api/meals/:id", requireAuth, (req, res) => {
    const id = Number(req.params.id);
    const meal = db.prepare(`
        SELECT image_path FROM meals WHERE id = ? AND user_id = ?
    `).get(id, req.user.id);

    if (!meal) return res.status(404).json({ error: "Meal not found." });

    db.prepare(`DELETE FROM meals WHERE id = ? AND user_id = ?`).run(id, req.user.id);
    deleteStoredImage(meal.image_path);

    res.json({ ok: true });
});

app.get("/api/meals/:id/image", requireAuth, (req, res) => {
    const id = Number(req.params.id);
    const meal = db.prepare(`
        SELECT image_path FROM meals WHERE id = ? AND user_id = ?
    `).get(id, req.user.id);

    if (!meal || !meal.image_path) return res.status(404).end();

    const absolute = path.resolve(DATA_DIR, meal.image_path);
    if (!absolute.startsWith(path.resolve(UPLOAD_DIR) + path.sep) || !fs.existsSync(absolute)) {
        return res.status(404).end();
    }

    res.sendFile(absolute);
});

// ------------------------------------------------------------
// AI FOOD ANALYSIS
// ------------------------------------------------------------

app.post("/api/analyze-food", requireAuth, async (req, res) => {
    try {
        if (!ai) {
            return res.status(503).json({
                error: "Gemini is not configured. Add GEMINI_API_KEY to .env."
            });
        }

        const image = req.body.image;
        if (!image) return res.status(400).json({ error: "Food image is required." });

        const match = image.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
        if (!match) return res.status(400).json({ error: "Invalid image format." });

        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: [
                { inlineData: { mimeType: match[1], data: match[2] } },
                {
                    text: `
You are an AI food nutrition assistant.
Analyze the food shown in the image and estimate nutrition for the visible serving.
These are estimates, not medical measurements.

Return ONLY valid JSON:
{
  "food_name": "string",
  "description": "string",
  "serving_size": "string",
  "calories": 0,
  "protein": 0,
  "carbs": 0,
  "fat": 0,
  "confidence": 0,
  "confidence_reason": "string"
}

Use calories in kcal and macros in grams.
If multiple foods are visible, estimate the complete visible meal.

CONFIDENCE RULES (important):
- confidence is the model's visual-identification confidence from 0 to 100, NOT nutrition accuracy.
- Use 90-100 when the food is clearly visible, distinctive, and the serving is easy to judge.
- Use 75-89 when the food is clearly identifiable but some ingredients or portion details are uncertain.
- Use 50-74 when the likely food is identifiable but the image is ambiguous, mixed, cropped, or the portion is difficult to judge.
- Use 25-49 when there are several plausible foods or visibility is poor.
- Use 0-24 when the food cannot be reliably identified.
- Do NOT use 1, 0, or a very low number just because nutrition values are estimates.
- Do not give 100 unless the image is exceptionally clear.
- confidence_reason should briefly explain the visual certainty (for example: "Chicken biryani is clearly visible, but exact portion size is uncertain.").

Do not use markdown. Return JSON only.
`
                }
            ],
            config: { responseMimeType: "application/json" }
        });

        const text = response.text;
        if (!text) throw new Error("Gemini returned an empty response.");

        let result;
        try {
            result = JSON.parse(text);
        } catch {
            const start = text.indexOf("{");
            const end = text.lastIndexOf("}");
            if (start < 0 || end < 0) throw new Error("Gemini returned invalid JSON.");
            result = JSON.parse(text.slice(start, end + 1));
        }

        result = {
            food_name: String(result.food_name || "Unknown food"),
            description: String(result.description || "Estimated nutrition"),
            serving_size: String(result.serving_size || "1 serving"),
            calories: Number(result.calories) || 0,
            protein: Number(result.protein) || 0,
            carbs: Number(result.carbs) || 0,
            fat: Number(result.fat) || 0,
            confidence: Math.max(0, Math.min(100, Number(result.confidence))),
            confidence_reason: String(result.confidence_reason || "Confidence is based on how clearly the food can be identified from the image.")
        };

        // Gemini can occasionally omit or return a non-useful confidence value.
        // In that case, derive a conservative visual-confidence score from the
        // returned analysis rather than falling back to 1%/0%. This is still a
        // visual identification estimate, not a claim of nutrition accuracy.
        if (!Number.isFinite(result.confidence) || result.confidence <= 0) {
            const description = result.description.toLowerCase();
            const serving = result.serving_size.toLowerCase();
            let fallback = 78;
            if (/unknown|cannot identify|unclear|not visible|ambiguous/.test(description)) fallback = 35;
            else if (/multiple|mixed|partially|cropped|obscured|uncertain/.test(description)) fallback = 62;
            else if (/uncertain|approx|estimated|about|rough/.test(serving)) fallback = 72;
            result.confidence = fallback;
            result.confidence_reason += " Visual-confidence fallback was applied because Gemini did not return a usable confidence score.";
        }
        result.confidence = Math.round(result.confidence);

        res.json(result);
    } catch (error) {
        console.error("Gemini analysis error:", error);
        res.status(500).json({
            error: "Gemini could not analyze this food image.",
            details: error.message
        });
    }
});

// ------------------------------------------------------------
// MIGRATION FROM V2 LOCAL STORAGE
// ------------------------------------------------------------

app.post("/api/migrate-local-data", requireAuth, (req, res) => {
    try {
        const profile = req.body.profile;
        const meals = Array.isArray(req.body.meals) ? req.body.meals : [];

        if (profile && Number(profile.weight) > 0) {
            const existing = getProfile(req.user.id);
            if (!existing || !existing.age) {
                try {
                    const calc = calculateTargets(profile);
                    db.prepare(`
                        UPDATE profiles
                        SET age=?, sex=?, height_cm=?, activity=?, goal=?,
                            calorie_target=?, protein_target=?, fat_target=?, carbs_target=?,
                            bmr=?, tdee=?, bmi=?, bmi_category=?, updated_at=?
                        WHERE user_id=?
                    `).run(
                        calc.age, calc.sex, calc.height_cm, calc.activity, calc.goal,
                        calc.calorie_target, calc.protein_target, calc.fat_target, calc.carbs_target,
                        calc.bmr, calc.tdee, calc.bmi, calc.bmi_category, now(), req.user.id
                    );

                    const migrationDate = new Date().toISOString().slice(0, 10);
                    db.prepare(`
                        INSERT INTO weight_entries (user_id, entry_date, weight_kg, note, created_at)
                        VALUES (?, ?, ?, ?, ?)
                        ON CONFLICT(user_id, entry_date) DO NOTHING
                    `).run(req.user.id, migrationDate, Number(profile.weight), "Imported from AI-FOOD V2", now());
                } catch {}
            }
        }

        let imported = 0;
        for (const meal of meals.slice(0, 1000)) {
            const name = String(meal.name || "").trim();
            if (!name) continue;

            const date = isDate(String(meal.date || ""))
                ? String(meal.date)
                : new Date().toISOString().slice(0, 10);

            const created = meal.createdAt || meal.time || now();
            db.prepare(`
                INSERT INTO meals
                    (user_id, meal_date, meal_type, name, serving, calories, protein, carbs, fat,
                     ai_description, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                req.user.id,
                date,
                ["Breakfast", "Lunch", "Dinner", "Snack"].includes(meal.type) ? meal.type : "Snack",
                name,
                String(meal.serving || "1 serving"),
                Number(meal.calories) || 0,
                Number(meal.protein) || 0,
                Number(meal.carbs) || 0,
                Number(meal.fat) || 0,
                "Imported from AI-FOOD V2",
                typeof created === "string" ? created : now()
            );
            imported++;
        }

        res.json({ ok: true, importedMeals: imported });
    } catch (error) {
        console.error("Migration error:", error);
        res.status(500).json({ error: "Could not migrate your old data." });
    }
});

// Cleanup expired sessions occasionally.
setInterval(() => {
    try {
        db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(now());
    } catch {}
}, 60 * 60 * 1000).unref();

app.listen(PORT, () => {
    console.log("========================================");
    console.log("        AI FOOD TRACKER V3");
    console.log("========================================");
    console.log(`Running at: http://localhost:${PORT}`);
    console.log(`Database: ${DB_PATH}`);
    console.log(`Gemini AI: ${ai ? "CONFIGURED" : "NOT CONFIGURED"}`);
    console.log("========================================");
});
