// AI-FOOD TRACKER V3
// Persistent accounts + daily body tracking + meal history + Gemini analysis.

let currentUser = null;
let currentProfile = null;
let currentDashboard = null;
let currentPhoto = "";
let authMode = "login";

const $ = (id) => document.getElementById(id);

const authScreen = $("authScreen");
const appScreen = $("appScreen");
const authForm = $("authForm");
const authName = $("authName");
const authEmail = $("authEmail");
const authPassword = $("authPassword");
const authMessage = $("authMessage");
const nameGroup = $("nameGroup");
const authSubmit = $("authSubmit");

function today() {
    return new Date().toISOString().slice(0, 10);
}

function formatDate(dateString) {
    if (!dateString) return "—";

    return new Date(`${dateString}T12:00:00`).toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric"
    });
}

function formatDateTime(value) {
    if (!value) return "—";

    return new Date(value).toLocaleString("en-IN", {
        dateStyle: "medium",
        timeStyle: "short"
    });
}

function escapeHTML(text) {
    const div = document.createElement("div");
    div.textContent = String(text ?? "");
    return div.innerHTML;
}

async function api(url, options = {}) {
    const response = await fetch(url, {
        credentials: "same-origin",
        ...options,
        headers: {
            ...(options.body ? { "Content-Type": "application/json" } : {}),
            ...(options.headers || {})
        }
    });

    let data = {};

    try {
        data = await response.json();
    } catch {}

    if (!response.ok) {
        const error = new Error(data.error || "Request failed.");
        error.status = response.status;
        throw error;
    }

    return data;
}

// ------------------------------------------------------------
// AUTH
// ------------------------------------------------------------

function setAuthMode(mode) {
    authMode = mode;

    document.querySelectorAll(".auth-tab").forEach((button) => {
        button.classList.toggle("active", button.dataset.mode === mode);
    });

    nameGroup.hidden = mode !== "register";

    authSubmit.textContent =
        mode === "register" ? "Create account" : "Log in";

    authPassword.autocomplete =
        mode === "register" ? "new-password" : "current-password";

    authMessage.textContent = "";
}

document.querySelectorAll(".auth-tab").forEach((button) => {
    button.addEventListener("click", () => {
        setAuthMode(button.dataset.mode);
    });
});

authForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    authMessage.textContent = "";
    authSubmit.disabled = true;

    try {
        const data = await api(`/api/auth/${authMode}`, {
            method: "POST",
            body: JSON.stringify({
                name: authName.value.trim(),
                email: authEmail.value.trim(),
                password: authPassword.value
            })
        });

        currentUser = data.user;

        authForm.reset();

        await enterApp(data.firstLogin);
    } catch (error) {
        authMessage.textContent = error.message;
        authMessage.className = "form-message error";
    } finally {
        authSubmit.disabled = false;
    }
});

async function checkSession() {
    try {
        const data = await api("/api/me");

        currentUser = data.user;
        currentProfile = data.profile;

        await enterApp(false);
    } catch {
        showAuth();
    }
}

function showAuth() {
    authScreen.hidden = false;
    appScreen.hidden = true;
}

async function enterApp(firstLogin) {
    authScreen.hidden = true;
    appScreen.hidden = false;

    $("welcomeTitle").textContent =
        `Welcome back, ${currentUser.name} 👋`;

    if (currentUser.previousLoginAt) {
        const previous = new Date(currentUser.previousLoginAt);

        const days = Math.max(
            0,
            Math.floor(
                (Date.now() - previous.getTime()) / 86400000
            )
        );

        $("lastVisit").textContent =
            `Last visit: ${formatDateTime(currentUser.previousLoginAt)}` +
            `${days ? ` • ${days} day${days === 1 ? "" : "s"} ago` : ""}`;
    } else {
        $("lastVisit").textContent =
            "This is your first visit. Let's build your history.";
    }

    await loadDashboard();

    if (firstLogin) {
        await migrateOldLocalData();
    }
}

async function migrateOldLocalData() {
    const oldProfile =
        localStorage.getItem("foodTrackerProfile");

    const oldMeals =
        localStorage.getItem("foodTrackerMeals");

    if (!oldProfile && !oldMeals) return;

    try {
        const result = await api("/api/migrate-local-data", {
            method: "POST",
            body: JSON.stringify({
                profile: oldProfile
                    ? JSON.parse(oldProfile)
                    : null,

                meals: oldMeals
                    ? JSON.parse(oldMeals)
                    : []
            })
        });

        if (result.importedMeals > 0 || oldProfile) {
            localStorage.removeItem("foodTrackerProfile");
            localStorage.removeItem("foodTrackerMeals");

            alert(
                `Your old V2 data has been imported into your new V3 account. ` +
                `${result.importedMeals} meal(s) imported.`
            );

            await loadDashboard();
        }
    } catch (error) {
        console.warn("V2 migration skipped:", error);
    }
}

// ------------------------------------------------------------
// DASHBOARD
// ------------------------------------------------------------

async function loadDashboard() {
    const data = await api(
        `/api/dashboard?date=${today()}`
    );

    currentDashboard = data;
    currentUser = data.user;
    currentProfile = data.profile;

    renderDashboard(data);
    fillBodyForm(data);
    fillProfileForm(data.profile);
}

function renderDashboard(data) {
    $("todayDate").textContent =
        new Date(`${data.date}T12:00:00`).toLocaleDateString(
            "en-IN",
            {
                weekday: "long",
                day: "numeric",
                month: "long",
                year: "numeric"
            }
        );

    const weight = data.weight
        ? Number(data.weight.weight_kg).toFixed(1) + " kg"
        : "—";

    $("todayWeight").textContent = weight;

    // MAIN PAGE AGE
    $("todayAge").textContent =
        data.profile?.age ?? "—";

    if (data.weightChange !== null) {
        const change = Number(data.weightChange);

        $("weightChange").textContent =
            `${change > 0 ? "+" : ""}${change.toFixed(1)} kg vs previous`;

        $("weightChange").className =
            change < 0
                ? "positive"
                : change > 0
                    ? "negative"
                    : "";
    } else {
        $("weightChange").textContent =
            "No previous entry";

        $("weightChange").className = "";
    }

    $("caloriesConsumed").textContent =
        Math.round(data.totals.calories);

    $("proteinConsumed").textContent =
        Math.round(data.totals.protein * 10) / 10;

    $("calorieGoal").textContent =
        data.profile?.calorie_target || "—";

    $("proteinGoal").textContent =
        data.profile?.protein_target || "—";

    // WATER
    $("waterConsumed").textContent =
        data.waterMl.toLocaleString("en-IN");

    const waterTarget =
        Number(data.waterTargetMl || 2500);

    $("waterTargetInput").value = waterTarget;

    const waterPct =
        waterTarget
            ? (data.waterMl / waterTarget) * 100
            : 0;

    $("waterProgress").style.width =
        `${Math.min(100, waterPct)}%`;

    $("waterProgressText").textContent =
        `${data.waterMl.toLocaleString("en-IN")} / ` +
        `${waterTarget.toLocaleString("en-IN")} ml`;

    renderWaterEntries(
        data.waterEntries || []
    );

    // CALORIES / PROTEIN
    const caloriePct =
        data.profile?.calorie_target
            ? data.totals.calories /
              data.profile.calorie_target *
              100
            : 0;

    const proteinPct =
        data.profile?.protein_target
            ? data.totals.protein /
              data.profile.protein_target *
              100
            : 0;

    $("calorieProgress").style.width =
        `${Math.min(100, caloriePct)}%`;

    $("proteinProgress").style.width =
        `${Math.min(100, proteinPct)}%`;

    $("calorieProgressText").textContent =
        `${Math.round(caloriePct)}%`;

    $("proteinProgressText").textContent =
        `${Math.round(proteinPct)}%`;

    renderMeals(data.meals);
}

// ------------------------------------------------------------
// MEALS
// ------------------------------------------------------------

function renderMeals(meals) {
    const list = $("mealList");

    list.innerHTML = "";

    $("mealCount").textContent =
        `${meals.length} ${meals.length === 1 ? "meal" : "meals"}`;

    if (!meals.length) {
        list.innerHTML = `
            <div class="empty-state">
                <div>🍽️</div>
                <h3>No meals added today</h3>
                <p>Take a food photo and save your first meal.</p>
            </div>
        `;

        return;
    }

    const icons = {
        Breakfast: "🍳",
        Lunch: "🍛",
        Dinner: "🍽️",
        Snack: "🍌"
    };

    meals.forEach((meal) => {
        const card = document.createElement("div");

        card.className = "meal-card";

        card.innerHTML = `
            <div class="meal-icon">
                ${icons[meal.meal_type] || "🍽️"}
            </div>

            <div class="meal-info">
                <h3>${escapeHTML(meal.name)}</h3>

                <p>
                    ${escapeHTML(meal.meal_type)}
                    •
                    ${new Date(meal.created_at)
                        .toLocaleTimeString("en-IN", {
                            hour: "2-digit",
                            minute: "2-digit"
                        })}
                </p>
            </div>

            <div class="meal-nutrition">
                <strong>
                    ${Math.round(meal.calories)} kcal
                </strong>

                <span>
                    ${Number(meal.protein).toFixed(1)}g protein
                </span>
            </div>

            <button
                class="delete-meal"
                data-id="${meal.id}"
                title="Delete meal"
            >
                🗑️
            </button>
        `;

        card
            .querySelector(".delete-meal")
            .addEventListener("click", () => {
                deleteMeal(meal.id);
            });

        list.appendChild(card);
    });
}

// ------------------------------------------------------------
// WATER
// ------------------------------------------------------------

function renderWaterEntries(entries) {
    const list = $("waterEntries");

    if (!entries.length) {
        list.innerHTML =
            `<p class="water-empty">No water added today.</p>`;

        return;
    }

    list.innerHTML = entries
        .map((entry) => `
            <div class="water-entry">
                <span>
                    💧 ${Number(entry.amount_ml)
                        .toLocaleString("en-IN")} ml
                </span>

                <small>
                    ${new Date(entry.created_at)
                        .toLocaleTimeString("en-IN", {
                            hour: "2-digit",
                            minute: "2-digit"
                        })}
                </small>

                <button
                    class="delete-water"
                    data-id="${entry.id}"
                    title="Remove water"
                >
                    ✕
                </button>
            </div>
        `)
        .join("");

    list
        .querySelectorAll(".delete-water")
        .forEach((button) => {
            button.addEventListener("click", async () => {
                try {
                    await api(
                        `/api/water/${button.dataset.id}`,
                        { method: "DELETE" }
                    );

                    await loadDashboard();
                } catch (error) {
                    alert(error.message);
                }
            });
        });
}

document
    .querySelectorAll("[data-water]")
    .forEach((button) => {
        button.addEventListener("click", async () => {
            try {
                await api("/api/water", {
                    method: "POST",
                    body: JSON.stringify({
                        date: today(),
                        amountMl: Number(
                            button.dataset.water
                        )
                    })
                });

                await loadDashboard();
            } catch (error) {
                alert(error.message);
            }
        });
    });

$("saveWaterTarget").addEventListener(
    "click",
    async () => {
        const target =
            Number($("waterTargetInput").value);

        if (
            !Number.isFinite(target) ||
            target < 1000 ||
            target > 6000
        ) {
            return alert(
                "Water target must be between 1000 and 6000 ml."
            );
        }

        const r = calculatePreview();

        if (!r) {
            return alert(
                "Please enter age, height and today's weight in your profile first."
            );
        }

        try {
            const data = await api(
                "/api/profile",
                {
                    method: "PUT",
                    body: JSON.stringify({
                        age: r.age,
                        sex: r.sex,
                        height: r.height,
                        weight: r.weight,
                        activity: r.activity,
                        goal: r.goal,
                        waterTargetMl: target
                    })
                }
            );

            currentProfile = data.profile;

            await loadDashboard();

        } catch (error) {
            alert(error.message);
        }
    }
);

// ------------------------------------------------------------
// BODY TRACKING
// ------------------------------------------------------------

function fillBodyForm(data) {
    // AGE
    if ($("ageTodayInput")) {
        $("ageTodayInput").value =
            data.profile?.age ?? "";
    }

    // WEIGHT
    $("weightTodayInput").value =
        data.weight?.weight_kg ?? "";

    // MEASUREMENTS
    const m =
        data.measurements?.find(
            (item) => item.entry_date === data.date
        );

    $("bodyFatInput").value =
        m?.body_fat ?? "";

    $("waistInput").value =
        m?.waist_cm ?? "";

    $("chestInput").value =
        m?.chest_cm ?? "";

    $("armInput").value =
        m?.arm_cm ?? "";

    $("thighInput").value =
        m?.thigh_cm ?? "";
}

// SAVE AGE + WEIGHT + MEASUREMENTS
$("saveBody").addEventListener(
    "click",
    async () => {
        try {
            const ageValue =
                $("ageTodayInput")
                    ? $("ageTodayInput").value.trim()
                    : "";

            const weightValue =
                $("weightTodayInput").value.trim();

            // -----------------------------------------
            // AGE
            // -----------------------------------------

            if (ageValue !== "") {
                const age = Number(ageValue);

                if (
                    !Number.isInteger(age) ||
                    age < 18 ||
                    age > 120
                ) {
                    throw new Error(
                        "Age must be between 18 and 120."
                    );
                }

                await api(
                    "/api/profile/age",
                    {
                        method: "PUT",
                        body: JSON.stringify({
                            age
                        })
                    }
                );
            }

            // -----------------------------------------
            // WEIGHT
            // -----------------------------------------

            if (weightValue !== "") {
                const weight =
                    Number(weightValue);

                if (
                    !Number.isFinite(weight) ||
                    weight < 30 ||
                    weight > 300
                ) {
                    throw new Error(
                        "Weight must be between 30 and 300 kg."
                    );
                }

                await api(
                    "/api/weights",
                    {
                        method: "POST",
                        body: JSON.stringify({
                            date: today(),
                            weight,
                            note: ""
                        })
                    }
                );
            }

            // -----------------------------------------
            // BODY MEASUREMENTS
            // -----------------------------------------

            const measurements = {
                date: today(),
                bodyFat: $("bodyFatInput").value,
                waist: $("waistInput").value,
                chest: $("chestInput").value,
                arm: $("armInput").value,
                thigh: $("thighInput").value
            };

            const hasMeasurements = [
                measurements.bodyFat,
                measurements.waist,
                measurements.chest,
                measurements.arm,
                measurements.thigh
            ].some(
                (value) =>
                    value !== "" &&
                    value !== null &&
                    value !== undefined
            );

            if (hasMeasurements) {
                await api(
                    "/api/body-measurements",
                    {
                        method: "POST",
                        body: JSON.stringify(
                            measurements
                        )
                    }
                );
            }

            // -----------------------------------------
            // REFRESH EVERYTHING
            // -----------------------------------------

            await loadDashboard();

            alert(
                "Age, weight and today's body data saved successfully. ✅"
            );

        } catch (error) {
            console.error(
                "Body data save error:",
                error
            );

            alert(
                error.message ||
                "Could not save today's body data."
            );
        }
    }
);

// ------------------------------------------------------------
// FOOD PHOTO + AI
// ------------------------------------------------------------

const foodPhoto = $("foodPhoto");
const photoSection = $("photoSection");
const foodPreview = $("foodPreview");
const resultSection = $("resultSection");
const loadingSection = $("loadingSection");
const resultImage = $("resultImage");
const analyzeBtn = $("analyzeBtn");
const removePhoto = $("removePhoto");
const saveMeal = $("saveMeal");

foodPhoto.addEventListener(
    "change",
    (event) => {
        const file =
            event.target.files[0];

        if (!file) return;

        if (file.size > 8 * 1024 * 1024) {
            alert(
                "Please choose an image smaller than 8 MB."
            );

            foodPhoto.value = "";

            return;
        }

        const reader =
            new FileReader();

        reader.onload = (e) => {
            currentPhoto =
                e.target.result;

            foodPreview.src =
                currentPhoto;

            photoSection.hidden =
                false;

            resultSection.hidden =
                true;

            loadingSection.hidden =
                true;

            photoSection.scrollIntoView({
                behavior: "smooth",
                block: "center"
            });
        };

        reader.readAsDataURL(file);
    }
);

removePhoto.addEventListener(
    "click",
    () => {
        currentPhoto = "";

        foodPhoto.value = "";

        photoSection.hidden =
            true;

        resultSection.hidden =
            true;

        loadingSection.hidden =
            true;
    }
);

analyzeBtn.addEventListener(
    "click",
    async () => {
        if (!currentPhoto) {
            return alert(
                "Please select a food photo first."
            );
        }

        analyzeBtn.disabled = true;
        analyzeBtn.textContent =
            "🤖 Analyzing...";

        loadingSection.hidden =
            false;

        resultSection.hidden =
            true;

        try {
            const data =
                await api(
                    "/api/analyze-food",
                    {
                        method: "POST",
                        body: JSON.stringify({
                            image: currentPhoto
                        })
                    }
                );

            $("foodName").textContent =
                data.food_name;

            $("foodDescription").textContent =
                data.description;

            $("servingInput").value =
                data.serving_size;

            $("foodInput").value =
                data.food_name;

            $("calorieInput").value =
                Math.round(data.calories);

            $("proteinInput").value =
                data.protein;

            $("carbsInput").value =
                data.carbs;

            $("fatInput").value =
                data.fat;

            $("confidence").textContent =
                `${Math.round(data.confidence)}%`;

            $("confidence").title =
                data.confidence_reason ||
                "AI visual-identification confidence";

            resultImage.src =
                currentPhoto;

            loadingSection.hidden =
                true;

            resultSection.hidden =
                false;

            resultSection.scrollIntoView({
                behavior: "smooth",
                block: "center"
            });

        } catch (error) {
            loadingSection.hidden =
                true;

            alert(error.message);

        } finally {
            analyzeBtn.disabled =
                false;

            analyzeBtn.textContent =
                "🤖 Analyze With AI";
        }
    }
);

saveMeal.addEventListener(
    "click",
    async () => {
        const payload = {
            date: today(),

            type:
                $("mealType").value,

            name:
                $("foodInput").value.trim(),

            serving:
                $("servingInput").value.trim() ||
                "1 serving",

            calories:
                Number($("calorieInput").value),

            protein:
                Number($("proteinInput").value),

            carbs:
                Number($("carbsInput").value),

            fat:
                Number($("fatInput").value),

            image:
                currentPhoto,

            description:
                $("foodDescription").textContent,

            confidence:
                Number.parseFloat(
                    $("confidence").textContent
                ) || null
        };

        if (!payload.name) {
            return alert(
                "Please enter the food name."
            );
        }

        if (
            ![
                payload.calories,
                payload.protein,
                payload.carbs,
                payload.fat
            ].every(
                (v) =>
                    Number.isFinite(v) &&
                    v >= 0
            )
        ) {
            return alert(
                "Please enter valid nutrition values."
            );
        }

        saveMeal.disabled = true;

        try {
            await api(
                "/api/meals",
                {
                    method: "POST",
                    body: JSON.stringify(
                        payload
                    )
                }
            );

            currentPhoto = "";

            foodPhoto.value = "";

            photoSection.hidden =
                true;

            resultSection.hidden =
                true;

            await loadDashboard();

            alert(
                "Meal saved to your permanent account history. ✅"
            );

        } catch (error) {
            alert(error.message);

        } finally {
            saveMeal.disabled =
                false;
        }
    }
);

// ------------------------------------------------------------
// PROFILE CALCULATOR
// ------------------------------------------------------------

function calculatePreview() {
    const age =
        Number($("ageInput").value);

    const sex =
        $("sexInput").value;

    const height =
        Number($("heightInput").value);

    const weight =
        Number(
            $("weightTodayInput").value ||
            currentDashboard?.weight?.weight_kg
        );

    const activity =
        Number($("activityInput").value);

    const goal =
        $("goalInput").value;

    if (
        ![
            age,
            height,
            weight,
            activity
        ].every(Number.isFinite)
    ) {
        return null;
    }

    const bmr =
        sex === "female"
            ? 10 * weight +
              6.25 * height -
              5 * age -
              161
            : 10 * weight +
              6.25 * height -
              5 * age +
              5;

    const tdee =
        bmr * activity;

    let calories =
        goal === "loss"
            ? tdee - 300
            : goal === "gain"
                ? tdee + 300
                : tdee;

    calories =
        Math.max(
            calories,
            sex === "female"
                ? 1200
                : 1500
        );

    const factor =
        activity <= 1.2
            ? 1.2
            : activity <= 1.375
                ? 1.4
                : activity <= 1.55
                    ? 1.6
                    : activity <= 1.725
                        ? 1.6
                        : 1.8;

    const protein =
        weight *
        (
            goal === "loss"
                ? Math.max(factor, 1.6)
                : factor
        );

    const fat =
        calories * 0.25 / 9;

    const carbs =
        Math.max(
            0,
            (
                calories -
                protein * 4 -
                calories * 0.25
            ) / 4
        );

    const bmi =
        weight /
        Math.pow(
            height / 100,
            2
        );

    const category =
        bmi < 18.5
            ? "Underweight"
            : bmi < 25
                ? "Healthy range"
                : bmi < 30
                    ? "Overweight"
                    : "Obesity range";

    return {
        age,
        sex,
        height,
        weight,
        activity,
        goal,
        bmr,
        tdee,
        calories,
        protein,
        fat,
        carbs,
        bmi,
        category
    };
}

function renderCalculator() {
    const r =
        calculatePreview();

    if (!r) return;

    $("calculatedBMR").textContent =
        `${Math.round(r.bmr)} kcal`;

    $("calculatedTDEE").textContent =
        `${Math.round(r.tdee)} kcal`;

    $("calculatedCalories").textContent =
        `${Math.round(r.calories)} kcal`;

    $("calculatedProtein").textContent =
        `${Math.round(r.protein)} g`;

    $("calculatedFat").textContent =
        `${Math.round(r.fat)} g`;

    $("calculatedCarbs").textContent =
        `${Math.round(r.carbs)} g`;

    $("calculatedBMI").textContent =
        r.bmi.toFixed(1);

    $("bmiCategory").textContent =
        r.category;
}

function fillProfileForm(profile) {
    if (!profile) return;

    $("ageInput").value =
        profile.age ?? "";

    $("sexInput").value =
        profile.sex || "male";

    $("heightInput").value =
        profile.height_cm ?? "";

    $("activityInput").value =
        profile.activity ?? 1.2;

    $("goalInput").value =
        profile.goal || "maintain";

    renderCalculator();
}

[
    "ageInput",
    "sexInput",
    "heightInput",
    "weightTodayInput",
    "activityInput",
    "goalInput"
].forEach((id) => {
    $(id).addEventListener(
        "input",
        renderCalculator
    );

    $(id).addEventListener(
        "change",
        renderCalculator
    );
});

$("saveGoals").addEventListener(
    "click",
    async () => {
        const r =
            calculatePreview();

        if (!r) {
            return alert(
                "Please enter age, height and today's weight first."
            );
        }

        try {
            const data =
                await api(
                    "/api/profile",
                    {
                        method: "PUT",
                        body: JSON.stringify({
                            age: r.age,
                            sex: r.sex,
                            height: r.height,
                            weight: r.weight,
                            activity: r.activity,
                            goal: r.goal
                        })
                    }
                );

            currentProfile =
                data.profile;

            closeModal(
                "settingsModal"
            );

            await loadDashboard();

            alert(
                "Profile and nutrition targets saved. ✅"
            );

        } catch (error) {
            alert(error.message);
        }
    }
);

// ------------------------------------------------------------
// MODALS
// ------------------------------------------------------------

function openModal(id) {
    $(id).classList.add("show");
}

function closeModal(id) {
    $(id).classList.remove("show");
}

$("settingsBtn").addEventListener(
    "click",
    () => {
        fillProfileForm(
            currentProfile
        );

        openModal(
            "settingsModal"
        );
    }
);

$("closeSettings").addEventListener(
    "click",
    () => {
        closeModal(
            "settingsModal"
        );
    }
);

$("historyBtn").addEventListener(
    "click",
    openHistory
);

$("openHistory").addEventListener(
    "click",
    openHistory
);

$("closeHistory").addEventListener(
    "click",
    () => {
        closeModal(
            "historyModal"
        );
    }
);

document
    .querySelectorAll(".modal")
    .forEach((modal) => {
        modal.addEventListener(
            "click",
            (event) => {
                if (
                    event.target === modal
                ) {
                    modal.classList.remove(
                        "show"
                    );
                }
            }
        );
    });

// ------------------------------------------------------------
// HISTORY
// ------------------------------------------------------------

async function openHistory() {
    try {
        const data =
            await api(
                "/api/history?limit=90"
            );

        const first =
            data.weights[0];

        const oldest =
            data.weights[
                data.weights.length - 1
            ];

        let summary =
            "No weight data yet.";

        if (first && oldest) {
            const change =
                Number(
                    first.weight_kg -
                    oldest.weight_kg
                );

            summary = `
                <div class="history-stat">
                    <strong>
                        ${data.weights.length}
                    </strong>
                    <span>
                        weight entries
                    </span>
                </div>

                <div class="history-stat">
                    <strong>
                        ${Number(first.weight_kg)
                            .toFixed(1)} kg
                    </strong>
                    <span>
                        latest weight
                    </span>
                </div>

                <div class="history-stat">
                    <strong>
                        ${change > 0 ? "+" : ""}
                        ${change.toFixed(1)} kg
                    </strong>
                    <span>
                        change across history
                    </span>
                </div>
            `;
        }

        $("historySummary").innerHTML =
            summary;

        let previous = null;

        $("weightHistory").innerHTML =
            data.weights
                .map((row) => {
                    const change =
                        previous === null
                            ? "—"
                            : `${(
                                Number(
                                    row.weight_kg
                                ) -
                                previous
                            ).toFixed(1)} kg`;

                    previous =
                        Number(
                            row.weight_kg
                        );

                    return `
                        <tr>
                            <td>
                                ${formatDate(
                                    row.entry_date
                                )}
                            </td>

                            <td>
                                <strong>
                                    ${Number(
                                        row.weight_kg
                                    ).toFixed(1)} kg
                                </strong>
                            </td>

                            <td>
                                ${change}
                            </td>
                        </tr>
                    `;
                })
                .join("") ||
            `
                <tr>
                    <td colspan="3">
                        No weight entries yet.
                    </td>
                </tr>
            `;

        $("measurementHistory").innerHTML =
            data.measurements
                .map(
                    (row) => `
                        <tr>
                            <td>
                                ${formatDate(
                                    row.entry_date
                                )}
                            </td>

                            <td>
                                ${
                                    row.body_fat == null
                                        ? "—"
                                        : row.body_fat + "%"
                                }
                            </td>

                            <td>
                                ${
                                    row.waist_cm == null
                                        ? "—"
                                        : row.waist_cm + " cm"
                                }
                            </td>

                            <td>
                                ${
                                    row.chest_cm == null
                                        ? "—"
                                        : row.chest_cm + " cm"
                                }
                            </td>

                            <td>
                                ${
                                    row.arm_cm == null
                                        ? "—"
                                        : row.arm_cm + " cm"
                                }
                            </td>

                            <td>
                                ${
                                    row.thigh_cm == null
                                        ? "—"
                                        : row.thigh_cm + " cm"
                                }
                            </td>
                        </tr>
                    `
                )
                .join("") ||
            `
                <tr>
                    <td colspan="6">
                        No body measurements yet.
                    </td>
                </tr>
            `;

        $("nutritionHistory").innerHTML =
            data.meals
                .map(
                    (row) => `
                        <tr>
                            <td>
                                ${formatDate(
                                    row.meal_date
                                )}
                            </td>

                            <td>
                                ${row.meal_count}
                            </td>

                            <td>
                                ${Math.round(
                                    row.calories
                                )} kcal
                            </td>

                            <td>
                                ${Number(
                                    row.protein
                                ).toFixed(1)} g
                            </td>

                            <td>
                                ${Number(
                                    row.carbs
                                ).toFixed(1)} g
                            </td>

                            <td>
                                ${Number(
                                    row.fat
                                ).toFixed(1)} g
                            </td>
                        </tr>
                    `
                )
                .join("") ||
            `
                <tr>
                    <td colspan="6">
                        No meal history yet.
                    </td>
                </tr>
            `;

        openModal(
            "historyModal"
        );

    } catch (error) {
        alert(error.message);
    }
}

// ------------------------------------------------------------
// LOGOUT
// ------------------------------------------------------------

$("logoutBtn").addEventListener(
    "click",
    async () => {
        if (
            !confirm(
                "Log out of AI-FOOD? Your saved data will remain in your account."
            )
        ) {
            return;
        }

        try {
            await api(
                "/api/auth/logout",
                {
                    method: "POST"
                }
            );
        } finally {
            currentUser = null;
            currentProfile = null;
            currentDashboard = null;

            showAuth();
        }
    }
);

// ------------------------------------------------------------
// START
// ------------------------------------------------------------

checkSession();