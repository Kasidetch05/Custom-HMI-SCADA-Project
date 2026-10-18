# Custom-HMI-SCADA-Project

---
Introduction

This project is a simulated HMI/SCADA dashboard for a small automated factory cell, built as a student project to learn industrial automation software without expensive hardware. In real factories, operators watch and control machines through HMI screens and SCADA systems, while a PLC runs the machine and a historian records what happens. I rebuilt this whole chain in software. A simulator plays the role of the PLC, a web dashboard acts as the operator screen, and a C# service works as the historian.

---
What it does

The simulation shows a robot cell where boxes arrive on a conveyor belt. A vision camera checks each box for defects: an open flap, a missing label, a dented corner or the wrong size. A robot arm then picks each box up. Good boxes go to the packing line and are packed six to a shipping case, and bad boxes are dropped into a reject bin. Everything is animated live in the browser. The operator can start, stop and reset the cell, press an emergency stop, change the line speed, and watch live numbers such as boxes packed, pass rate and OEE. Alarms explain in plain language what went wrong and what to do next. A practice mode lets users trigger faults on purpose, such as a safety stop, a belt jam or a bad batch, and learn how to recover. A C# historian records every inspection, alarm and stop in a database and turns it into shift reports with CSV export.

---
Tech Stack and Software used

The simulator and web server are written in JavaScript on Node.js, using Express and WebSocket so data reaches the screen in real time. The dashboard is built with HTML, CSS and JavaScript. It draws the animated robot on an HTML canvas and uses Chart.js for the charts. The historian is written in C# on .NET 10 with ASP.NET Core, because C# is widely used in industrial software. It stores data with SQL in a SQLite database, a single file that needs no separate database server. All the parts exchange data as JSON. The project was developed in Visual Studio Code with the help of Claude Code, an AI coding assistant, and runs in any modern browser such as Chrome or Edge.

---
Limitations

This is a learning project, not production software. The cell is a simplified 2D side view, the robot moves as a three-joint arm, and the camera picks defects at random instead of analysing real images. The emergency stop and safety stop are only simulated. A software button can never replace the hard-wired, safety-rated circuits that real machines need. There are no user logins, no HTTPS and no network security, so it is meant to run on a local computer only. It supports a single cell, the live counters reset when the simulator restarts, and SQLite suits a small setup rather than a whole factory. There are no automated tests yet.

---
How to integrate this into real life

The project is designed so that only the simulator needs replacing to connect real equipment. The dashboard and historian only depend on the data format, not on where the data comes from. In a real factory, the simulator would be swapped for a driver that reads and writes PLC tags using a standard industrial protocol such as OPC UA, Modbus TCP or MQTT, after agreeing a tag list with the PLC programmer. Safety functions such as emergency stops and light curtains must stay hard-wired in the PLC. The HMI should only display their status and send requests that the PLC checks against its own interlocks. Before going live, the system would need user logins and roles, HTTPS, and a separate network behind a firewall. For several production lines, SQLite would be replaced with SQL Server or a time-series database. A safe rollout would start with read-only monitoring of one machine, then add reports, and only add operator commands after testing with a controls engineer.

---
