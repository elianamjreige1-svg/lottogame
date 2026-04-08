const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mysql = require('mysql2/promise');
const util = require("util");

let winprice = 0;
let pointamount = 0;
let canplay = false;

let lastResult = null; // ✅ جديد

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

app.use(express.json());
app.use(express.static("public"));

// ================= DB =================
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false },
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

pool.on('error', (err) => {
  console.error("MySQL Pool Error:", err);
});

const query = util.promisify(pool.query).bind(pool);

// keep alive
setInterval(async () => {
  try {
    await query("SELECT 1");
    console.log("Keep-alive ping");
  } catch (err) {
    console.error("Keep-alive failed:", err);
  }
}, 30000);

// ================= SOCKET =================
io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    // ✅ إذا في نتيجة سابقة ابعتيها
    if (lastResult) {
        socket.emit("result", lastResult);
    }

    socket.on("disconnect", () => {
        console.log("User disconnected:", socket.id);
    });
});

// ================= LOG =================
function log(msg) {
    console.log(msg);
    io.emit("log", msg);
}

// ================= VARIABLES =================
let tickets = [];
let resultsbyuser = [];

query('UPDATE users SET played = 0');

// ================= HELPERS =================
function generateNumbers() {
    let nums = [];
    while (nums.length < 3) {
        let n = Math.floor(Math.random() * 16) + 1;
        if (!nums.includes(n)) nums.push(n);
    }
    log("Players: " + tickets.length);
    return nums;
}

function roundTo(num, precision) {
  const factor = Math.pow(10, precision);
  return Math.round(num * factor) / factor;
}

// ================= GAME =================

// START
app.get("/start", async (req, res) => {
    canplay = true;
    tickets = [];
    resultsbyuser = [];
    winprice = 0;
    lastResult = null; // ✅ reset

    await query('UPDATE users SET played = 0');

    log("Game started");
    io.emit("announce", { ancmtmsg: "done" });

    res.send("ok");
});

let jackpot = 0;

app.post("/ticket", async (req, res) => {
    const { userId, numbers } = req.body;

    if (!canplay) {
        return res.json({ message: "Game closed" });
    }

    try {
        const result = await query(
            'UPDATE users SET played = 1, balance = balance - 3 WHERE username = ?',
            [userId]
        );

        jackpot = roundTo(winprice * 0.9, 2).toFixed(2);

        if (result.affectedRows === 0) {
            io.emit("updatedjackpot", { jackpot });
            return res.json({ message: "Already played", jackpot });
        }

        tickets.push({ userId, numbers });
        winprice += 3;

        jackpot = roundTo(winprice * 0.9, 2).toFixed(2);

        io.emit("updatedjackpot", { jackpot });

        res.json({ message: "Ticket submitted", jackpot });

    } catch (err) {
        console.error(err);
        res.status(500).send("DB error");
    }
});

// DRAW
app.get("/draw", async (req, res) => {
    try {
        const draw = generateNumbers();
        let results = [];
        let totalmatches = 0;

        winprice = roundTo(winprice * 0.9, 2);

        tickets.forEach(ticket => {
            const playerNumbers = ticket.numbers.map(Number);
            let matches = playerNumbers.filter(n => draw.includes(n)).length;

            let reward = 0;
            if (matches === 1) reward = 1;
            else if (matches === 2) reward = 8;
            else if (matches === 3) reward = 200;

            if (reward > 0) {
                resultsbyuser.push(ticket.userId, reward);
                totalmatches += reward;
            }

            results.push({
                userId: ticket.userId,
                numbers: ticket.numbers,
                matches: reward,
                win: reward + " $"
            });
        });

        if (totalmatches === 0) {
            pointamount = 0;
        } else {
            pointamount = roundTo(winprice / totalmatches, 2);
        }

        // update balances
        for (let i = 0; i < resultsbyuser.length; i += 2) {
            const username = resultsbyuser[i];
            const value = resultsbyuser[i + 1] * pointamount;

            await query(
                'UPDATE users SET balance = balance + ? WHERE username = ?',
                [value, username]
            );
        }

        // ✅ خزّن النتيجة
        lastResult = {
            draw: draw.join(" "),
            results,
            winp: winprice,
            pointamount
        };

        // ✅ أرسلها
        io.emit("result", lastResult);
        io.emit("gameclosed", { msgclose: "game closed" });

        log("Draw: " + draw.join(", "));
        log("Total: " + winprice);
        log("Point value: " + pointamount);

        tickets = [];
        resultsbyuser = [];
        winprice = 0;
        canplay = false;

        res.json({ draw });

    } catch (err) {
        console.error("DRAW ERROR:", err);
        res.status(500).send("Draw error");
    }
});

app.post("/register", async (req, res) => {
  const username = req.body.username.toLowerCase();
  const pa = req.body.passwd;

  let olduser = 0;

  try {
    const results = await query(
      'SELECT * FROM users WHERE username = ? AND password = ?',
      [username, pa]
    );

    if (results.length > 0) {
      const user = results[0];
/*if(user.username==au && user.password==ap){
	//window.location.replace(pg);
	return res.json({redirect:pg});
	}*/
      if (user.played == 1) olduser = 1;

      const jackpotValue = roundTo(winprice * 0.9, 2);

      res.json({
        userId: username,
        num: user.roundtype,
        balance: roundTo(user.balance, 2).toFixed(2),
        old: olduser,
        jackpot: jackpotValue,
        usernbs: tickets
          .filter(obj => obj.userId === username)
          .flatMap(obj => obj.numbers),
        canplay: canplay
      });

    } else {
      res.json({ userId: null });
    }

  } catch (err) {
    console.error(err);
    res.status(500).send("DB error");
  }
});

// AGAIN
app.get("/again", async (req, res) => {
    canplay = true;
    tickets = [];
    resultsbyuser = [];
    lastResult = null;

    await query('UPDATE users SET played = 0');

    log("Game reset");
    io.emit("announce", { ancmtmsg: "done" });

    res.send("ok");
});

// ================= SERVER =================
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log("Server running on port " + PORT);
});
