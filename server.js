const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mysql = require('mysql2');
const util = require("util");

let winprice=0;
let pointamount = 0;
let canplay = false;

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
  ssl: {
    rejectUnauthorized: false
  }
});
pool.on('error', (err) => {
  console.error("MySQL Pool Error:", err);
});

const query = util.promisify(pool.query).bind(pool);
/*try {
  const [results] = await query('SELECT * FROM lottoprice');

  if (results.length > 0) {
    let w = results[0].winprice;
    winprice = w;
  } else {
    winprice = 0;
  }

  console.log("winprice=" + winprice);

} catch (err) {
  console.error(err);
}*/
/*try {
    const results =  query(
      'SELECT * FROM lottoprice '
    );

    if (results.length > 0) {
      const w= results[0].winprice;

      winprice = w;

      

    } 

  } catch (err) {
    console.error(err);
    res.status(500).send("DB error");
  }*/

// ================= LOG =================
function log(msg) {
    console.log(msg);
    io.emit("log", msg);
}

// ================= VARIABLES =================
let tickets = [];
let resultsbyuser = [];

// reset played on start
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

// ================= USERS CRUD =================

// GET
app.get("/users", async (req, res) => {
    const users = await query("SELECT username, balance FROM users");
    res.json(users);
});

// ADD
app.post("/users", async (req, res) => {
    const { username, password, balance } = req.body;

    await query(
        "INSERT INTO users (username, password, balance) VALUES (?, ?, ?)",
        [username, password, balance]
    );

    log("User added: " + username);
    res.send("ok");
});

// UPDATE
app.put("/users/:username", async (req, res) => {
    const oldUsername = req.params.username;
    const { username, balance } = req.body;

    await query(
        "UPDATE users SET username=?, balance=? WHERE username=?",
        [username, balance, oldUsername]
    );

    log("User updated: " + oldUsername + " -> " + username);
    res.send("ok");
});

// DELETE
app.delete("/users/:username", async (req, res) => {
	
    const username = req.params.username;

    await query("DELETE FROM users WHERE username=?", [username]);

    log("User deleted: " + username);
    res.send("ok");
});

// ================= GAME =================

// START
app.get("/start", async (req, res) => {
    canplay = true;
    tickets = [];
    resultsbyuser = [];
    winprice = 0;

    await query('UPDATE users SET played = 0');

    log("Game started");
	io.emit("announce", { ancmtmsg: "done" });
    res.send("ok");
});
let jackpot=0;
app.post("/ticket", async (req, res) => {
    const { userId, numbers } = req.body;

    if (!canplay) {
        return res.json({ message: "Game closed" });
    }

    try {
        const result = await query(
            'UPDATE users SET played = 1, balance = balance - 3 WHERE username = ? and played=0',
            [userId]
        );
		
		 jackpot= roundTo(Number(winprice),2).toFixed(2);
	
        // already played
		
        if (result.affectedRows === 0) {
			io.emit("updatedjackpot",{message:"Already played",jackpot:jackpot});
        return res.json({ message: "Already played",jackpot:jackpot });
		  // res.json({ message: "Ticket submitted" });
        }

        tickets.push({ userId, numbers });
        winprice = Number(winprice) + 2.7;
		winprice=roundTo(winprice,2).toFixed(2);
		 jackpot=winprice;
        res.json({ message: "Ticket submitted",jackpot:jackpot });
		io.emit("updatedjackpot",{message:"Ticket submitted",jackpot:jackpot});
	//log("jackpot in ticket="+jackpot);
    } catch (err) {
        console.error(err);
        res.status(500).send("DB error");
    }
});

// DRAW
app.get("/draw", async (req, res) => {

    const draw = generateNumbers();
    let results = [];
    let totalmatches = 0;

    winprice = roundTo(winprice, 2).toFixed(2);

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
			numbers:ticket.numbers,
            matches:reward,
            win:reward+" $"
        });
    });

    if (totalmatches === 0) {
        pointamount = 0;
    } else {
        pointamount = roundTo(winprice / totalmatches, 2).toFixed(2);
		//winprice=0;
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
	

	//log("winprice draw="+winprice);
    io.emit("result", {
        draw:draw.join(" "),
        results,
        winp:winprice,
        pointamount
    });

    log("Draw: " + draw.join(", "));
    log("Total: " + winprice);
    log("Point value: " + pointamount);

    tickets = [];
    resultsbyuser = [];
	if(pointamount!=0){
    winprice = 0;}
	//else
	//	winprice=winprice;
    canplay = false;

    res.json({ draw });
	await query(
            'UPDATE lottoprice SET winprice =  ? where id=1',
            [winprice]
        );
	//io.emit("gameclosed",{msgclose:"game closed"});
	

	
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

      if (user.played == 1) olduser = 1;

      const jackpotValue = roundTo(winprice,2).toFixed(2);

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

    await query('UPDATE users SET played = 0');

    log("Game reset");
    res.send("ok");
	io.emit("announce", { ancmtmsg: "done" });
	try {
  const results = await query('SELECT * FROM lottoprice where id=1');
//log("results.length = "+results.length);
  if (results.length > 0) {
   const w = results[0].winprice;
    winprice = roundTo(w,2).toFixed(2);
  } else {
    winprice = 0;
  }
//jackpot=winprice;
  //log("winprice again=" + winprice);

} catch (err) {
  console.error(err);
}
});

// ================= SERVER =================
// ================= SERVER =================

async function startServer() {
  try {
    const [results] = await query('SELECT * FROM lottoprice where id=1');

    if (results.length > 0) {
      winprice = Number(results[0].winprice);
		winprice=roundTo(winprice,2).toFixed(2);
    } else {
      winprice = 0;
    }

  //  log("winprice=" + winprice);

   const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log("Server running on port " + PORT);
});

  } catch (err) {
    console.error(err);
  }
}
startServer();

