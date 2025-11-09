# ⚙️ AST Miner CLI

A **TypeScript-based Proof-of-Work (PoW) mining client** built for the **Astatine** Mining Chain.  
The miner connects directly to Injective RPC endpoints and attempts to find valid nonces for on-chain mining smart contracts.

---

## 🧠 What Is AST Miner CLI?

**AST Miner CLI** is the official command-line miner for the **Astatine Proof-of-Work system**.  
It enables anyone to participate in Astatine mining directly from their terminal : verifying work, finding nonces, and submitting valid blocks to the network via **Own Computer Power**.

This miner is fully open-source, easy to run, and optimized for CPU-based mining.

---

## 🚀 Quick Start

### Pre-Requirements
- You need some INJ (more than 1 INJ) in your wallet during the mining.
- You need your mnemonic keys of your wallet.

### 1️⃣ Install Dependencies
```bash
git clone https://github.com/Jecta-ai/ast-miner-cli.git
cd ast-miner-cli
npm install
```

### 2️⃣ Start Mining
Run directly using `ts-node` (no compilation required):

```bash
npx ts-node miner.ts --mnemonic "your mnemonic here"
```

💡 **Example Output:**
```
      █████╗ ███████╗████████╗ █████╗ ████████╗██╗███╗   ██╗███████╗
     ██╔══██╗██╔════╝╚══██╔══╝██╔══██╗╚══██╔══╝██║████╗  ██║██╔════╝
     ███████║███████╗   ██║   ███████║   ██║   ██║██╔██╗ ██║█████╗  
     ██╔══██║╚════██║   ██║   ██╔══██║   ██║   ██║██║╚██╗██║██╔══╝  
     ██║  ██║███████║   ██║   ██║  ██║   ██║   ██║██║ ╚████║███████╗
     ╚═╝  ╚═╝╚══════╝   ╚═╝   ╚═╝  ╚═╝   ╚═╝   ╚═╝╚═╝  ╚═══╝╚══════╝ miner-cli

Astatine Miner  | Address inj1p..0ykj  
AST Balance 1901562.50  INJ Balance 2.52  
H/s 4,000,000  | Left 04:42  | Block 20  | Target 0x00000064…
Reward 12500 AST | Best —
Finalize TX :  not available 
Mining TX :  not available  
Best Miner :  not available  
 w00: ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮ 400,000 H/s
 w01: ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮ 400,000 H/s
 w02: ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮ 400,000 H/s
 w03: ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮ 400,000 H/s
 w04: ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮ 400,000 H/s
 w05: ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮ 400,000 H/s
 w06: ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮ 400,000 H/s
 w07: ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮ 400,000 H/s
 w08: ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮ 400,000 H/s
 w09: ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮ 400,000 H/s
```

---

## ⚙️ Environment Setup

You can define your target validator to mine using `.env` file in the repo.
Please configure it with 1,2 or 3 only:

EXAMPLE
```bash
VALIDATOR_NO=1
```

---

## 🧩 Project Structure

```
ast-miner-cli/
├── miner.ts             # Main mining entry point
├── package.json         # Dependencies and scripts
├── .env                 # Environment variables
├── tsconfig.miner.json  # TypeScript configuration
└── tsconfig.json        # TypeScript configuration
```

---

## 💻 System Requirements

| Requirement | Minimum |
|--------------|----------|
| Node.js | v18+ |
| CPU | 2+ cores recommended |
| RAM | 2 GB minimum |
| OS | macOS, Linux, or Windows |
| Network | Stable internet connection |

---

## 🔐 Security Notice

> Your **mnemonic** is never transmitted or stored remotely.  
> All signing happens locally, on your own device.

**Safety tips:**
- Never share your mnemonic or private key.  
- Avoid using your main wallet; use a **dedicated mining wallet**.  
- Review code before running any binaries from third parties.  

---

## 🧱 Mining Logic (Simplified)

1. Connects to Injective RPC endpoint  
2. Fetches current target difficulty from contract  
3. Computes hashes using local CPU threads  
4. If a valid nonce is found → submits transaction  
5. Contract validates and rewards successful miners  

This process repeats continuously, adapting to the **Astatine halving schedule** and difficulty retargets.

---

## 🤝 Contributing

Contributions are welcome!  
If you’d like to improve hashing performance, optimize RPC calls, or extend support for GPU/parallel mining:

1. Fork the repo  
2. Create a feature branch  
3. Submit a PR  

Please open issues for:
- Feature requests  
- Bug reports  
- Performance improvements  

---

## 📜 License

This project is licensed under the **MIT License**.  
© 2025 [Jecta AI](https://github.com/Jecta-ai) — All Rights Reserved.

---

## 🌐 Links & Resources

- 🌍 [Jecta AI GitHub](https://github.com/Jecta-ai)
- ⚙️ [Astatine Official Page](https://astatine.work)
- 💬 [Injective Developer Portal](https://docs.injective.network)
- 🧠 [Astatine Whitepaper](https://www.astatine.work/Whitepaper.pdf)

---

⭐ **Star this repo** to support the open-source Astatine miner and help the decentralized ecosystem grow!
