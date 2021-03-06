import { sha256 } from "js-sha256";
import { serialize, deserialize } from "serializer.ts/Serializer";
import BigNumber from "bignumber.js";

import * as fs from "fs";
import * as path from "path";
import deepEqual = require("deep-equal");

import * as uuidv4 from "uuid/v4";
import * as express from "express";
import * as bodyParser from "body-parser";
import { URL } from "url";
import axios from "axios";

import { Set } from "typescript-collections";
import * as parseArgs from "minimist";
import { request } from "https";

import * as NodeRSA from "node-rsa";
import * as expressFileUpload from "express-fileupload";

export type Address = string;

export class Transaction {
  public senderAddress: Address;
  public transactionType: string;
  public transactionContent: any;

  constructor(senderAddress: Address, recipientAddress: Address, value: number,transactionType: string, vote: string, isEncrypted:boolean ) {
    this.senderAddress = senderAddress;
    this.transactionType = transactionType
    var content = {
      recipientAddress : recipientAddress,
      value : value,
      vote : vote
    };
    if (isEncrypted) {
      //encrypt the transaction content
      this.transactionContent = blockchain.getPublicKey().encrypt(JSON.stringify(content),'base64');
    } else {
      this.transactionContent = content;
    }

  }
}

export class Block {
  public blockNumber: number;
  public transactions: Array<Transaction>;
  public timestamp: number;
  public nonce: number;
  public prevBlock: string;

  constructor(blockNumber: number, transactions: Array<Transaction>, timestamp: number, nonce: number,
    prevBlock: string) {
    this.blockNumber = blockNumber;
    this.transactions = transactions;
    this.timestamp = timestamp;
    this.nonce = nonce;
    this.prevBlock = prevBlock;
  }

  // Calculates the SHA256 of the entire block, including its transactions.
  public sha256(): string {
    return sha256(JSON.stringify(serialize<Block>(this)));
  }
}

export class Node {
  public id: string;
  public url: URL;

  constructor(id: string, url: URL) {
    this.id = id;
    this.url = url;
  }

  public toString(): string {
      return `${this.id}:${this.url}`;
  }
}

export class Blockchain {
  // Let's define that our "genesis" block as an empty block, starting from the January 1, 1970 (midnight "UTC").
  public static  GENESIS_BLOCK:Block; 

  public static readonly DIFFICULTY = 4;
  public static readonly TARGET = 2 ** (256 - Blockchain.DIFFICULTY);

  public static readonly MINING_SENDER = "<COINBASE>";
  public static readonly MINING_REWARD = 50;

  public nodeId: string;
  public nodes: Set<Node>;
  public blocks: Array<Block>;
  public transactionPool: Array<Transaction>;
  private storagePath: string;

  private publicKey: any;
  public active = true; // allow adding new transactions to the blockchain

  constructor(nodeId: string, votingOptions: string, publicKeyFile:string) {
    //Set the genesis block to hold the available votion options
    Blockchain.GENESIS_BLOCK = new Block(0, [], 0, 0,votingOptions);

    this.nodeId = nodeId;
    this.nodes = new Set<Node>();
    this.transactionPool = [];

    this.storagePath = path.resolve(__dirname, "../", `${this.nodeId}.blockchain`);
    this.publicKey = new NodeRSA(this.loadPublicKey(publicKeyFile));
    
    // Load the blockchain from the storage.
    this.load();
  }

  public getPublicKey() {
    return this.publicKey;
  }

  // Registers new node.
  public register(node: Node): boolean {
    return this.nodes.add(node);
  }

  // Saves the blockchain to the disk.
  private save() {
    fs.writeFileSync(this.storagePath, JSON.stringify(serialize(this.blocks), undefined, 2), "utf8");
  }

  //load the public key used by voter to encrypt their votes
  private loadPublicKey(filename: string) {
    var file_path= path.resolve(__dirname,'../',filename);
    return fs.readFileSync(file_path, "utf8");
  }

  // Loads the blockchain from the disk.
  private load() {
    try {
      this.blocks = deserialize<Block[]>(Block, JSON.parse(fs.readFileSync(this.storagePath, "utf8")));
    } catch (err) {
      if (err.code !== "ENOENT") {
        throw err;
      }

      this.blocks = [Blockchain.GENESIS_BLOCK];
    } finally {
      this.verify();
    }
  }

  // Verifies the blockchain.
  public static verify(blocks: Array<Block>): boolean {
    try {
      // The blockchain can't be empty. It should always contain at least the genesis block.
      if (blocks.length === 0) {
        throw new Error("Blockchain can't be empty!");
      }

      // The first block has to be the genesis block.
      if (!deepEqual(blocks[0], Blockchain.GENESIS_BLOCK)) {
        throw new Error("Invalid first block!");
      }

      // Verify the chain itself.
      for (let i = 1; i < blocks.length; ++i) {
        const current = blocks[i];

        // Verify block number.
        if (current.blockNumber !== i) {
          throw new Error(`Invalid block number ${current.blockNumber} for block #${i}!`);
        }

        // Verify that the current blocks properly points to the previous block.
        const previous = blocks[i - 1];
        if (current.prevBlock !== previous.sha256()) {
          throw new Error(`Invalid previous block hash for block #${i}!`);
        }

        // Verify the difficutly of the PoW.
        //
        // TODO: what if the diffuclty was adjusted?
        if (!this.isPoWValid(current.sha256())) {
          throw new Error(`Invalid previous block hash's difficutly for block #${i}!`);
        }
      }

      return true;
    } catch (err) {
      console.error(err);
      return false;
    }
  }

  // Verifies the blockchain.
  private verify() {
    // The blockchain can't be empty. It should always contain at least the genesis block.
    if (!Blockchain.verify(this.blocks)) {
      throw new Error("Invalid blockchain!");
    }
  }

  // Receives candidate blockchains, verifies them, and if a longer and valid alternative is found - uses it to replace
  // our own.
  public consensus(blockchains: Array<Array<Block>>): boolean {
    // Iterate over the proposed candidates and find the longest, valid, candidate.
    let maxLength: number = 0;
    let bestCandidateIndex: number = -1;
    
    for (let i = 0; i < blockchains.length; ++i) {
      const candidate = blockchains[i];

      // Don't bother validating blockchains shorther than the best candidate so far.
      if (candidate.length <= maxLength) {
        continue;
      }

      // Found a good candidate?
      if (Blockchain.verify(candidate)) {
        maxLength = candidate.length;
        bestCandidateIndex = i;
      }
    }

    // Compare the candidate and consider to use it.
    if (bestCandidateIndex !== -1 && (maxLength > this.blocks.length || !Blockchain.verify(this.blocks))) {
      this.blocks = blockchains[bestCandidateIndex];
      this.save();

      return true;
    }

    return false;
  }

  // Validates PoW.
  public static isPoWValid(pow: string): boolean {
    try {
      if (!pow.startsWith("0x")) {
        pow = `0x${pow}`;
      }

      return new BigNumber(pow).lessThanOrEqualTo(Blockchain.TARGET.toString());
    } catch {
      return false;
    }
  }

  // Mines for block.
  private mineBlock(transactions: Array<Transaction>): Block {
    // Create a new block which will "point" to the last block.
    const lastBlock = this.getLastBlock();
    const newBlock = new Block(lastBlock.blockNumber + 1, transactions, Blockchain.now(), 0, lastBlock.sha256());

    while (true) {
      const pow = newBlock.sha256();
      console.log(`Mining #${newBlock.blockNumber}: nonce: ${newBlock.nonce}, pow: ${pow}`);

      if (Blockchain.isPoWValid(pow)) {
        console.log(`Found valid POW: ${pow}!`);
        break;
      }

      newBlock.nonce++;
    }

    return newBlock;
  }

  // Submits new transaction if the blockchain is enabled
  public submitTransaction(senderAddress: Address, recipientAddress: Address, value: number, type: string, vote: string, isEncrypted:boolean) {
    if (blockchain.active) 
      this.transactionPool.push(new Transaction(senderAddress, recipientAddress, value, type, vote, isEncrypted));
    else 
      console.log('Can\'t add more transaction to the blockchain. Blockchain is not active');
  }

  // Creates new block on the blockchain.
  public createBlock(): Block {
    // Add a "coinbase" transaction granting us the mining reward!
    const transactions = [new Transaction(Blockchain.MINING_SENDER, this.nodeId, Blockchain.MINING_REWARD, "REWARD", "", false),
      ...this.transactionPool];

    // Mine the transactions in a new block.
    const newBlock = this.mineBlock(transactions);

    // Append the new block to the blockchain.
    this.blocks.push(newBlock);

    // Remove the mined transactions.
    this.transactionPool = [];

    // Save the blockchain to the storage.
    this.save();

    return newBlock;
  }

  public getLastBlock(): Block {
    return this.blocks[this.blocks.length - 1];
  }

  public static now(): number {
    return Math.round(new Date().getTime() / 1000);
  }
}

/**
 * check if a vote selection is part of the options defined in the GENESIS block
 * @param value - vote selection 
 */
function isValidVote(value:string) {
  return Blockchain.GENESIS_BLOCK.prevBlock.toLowerCase().includes(value.toLowerCase())
}

/**
 * 
 * @param voter check if a voter has already took a vote
 * we do this by:
 * 1. going over all of the transcations within the blockchain, looking for a transaction which 
 * contains this voter (sendingAddress)
 * 2. going over the transaction pool - looking at pre-mined transactions  
 */
function isValidVoter(voter:string) {

  for (let i = 0; i < blockchain.blocks.length; ++i) {
    console.log("validating voter ",voter);
    let transactions= blockchain.blocks[i].transactions;
    
    for (let j=0; j< transactions.length; j++ ) {
      if (transactions[j].senderAddress == voter) {
        console.log('Voter ',voter,'has already voted in block ',i)
        return false
      }
    }
  }

  for (let i=0; i< blockchain.transactionPool.length;i++ ) {
    if (blockchain.transactionPool[i].senderAddress == voter) {
      console.log('Voter ',voter,'has already voted. Vote found in transaction pool ',i);
      return false
    }
  }


  return true;
}


// Web server:
const ARGS = parseArgs(process.argv.slice(2));
const PORT = ARGS.port || 3000;
const app = express();
const nodeId = ARGS.id || uuidv4();
const votingOptions = ARGS.voting_options || 'yes,no';
const publicKeyFile = ARGS.public_key_filename || null;
const blockchain = new Blockchain(nodeId, votingOptions, publicKeyFile);

// Set up bodyParser:
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error(err.stack);

  res.status(500);
});
app.use(expressFileUpload());

// Show all the blocks.
app.get("/blocks", (req: express.Request, res: express.Response) => {
  res.json(serialize(blockchain.blocks));
});

// Show specific block.
app.get("/blocks/:id", (req: express.Request, res: express.Response) => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.json("Invalid parameter!");
    res.status(500);
    return;
  }

  if (id >= blockchain.blocks.length) {
    res.json(`Block #${id} wasn't found!`);
    res.status(404);
    return;
  }

  res.json(serialize(blockchain.blocks[id]));
});

app.post("/blocks/mine", (req: express.Request, res: express.Response) => {
  // Mine the new block.
  const newBlock = blockchain.createBlock();

  res.json(`Mined new block #${newBlock.blockNumber}`);
});

// Show all transactions in the transaction pool.
app.get("/transactions", (req: express.Request, res: express.Response) => {
  res.json(serialize(blockchain.transactionPool));
});

app.post("/transactions", (req: express.Request, res: express.Response) => {
  const senderAddress = req.body.senderAddress;
  const recipientAddress = req.body.recipientAddress;
  const value = Number(req.body.value);

  if (!senderAddress || !recipientAddress || !value)  {
    res.json("Invalid parameters!");
    res.status(500);
    return;
  }

  blockchain.submitTransaction(senderAddress, recipientAddress, value, 'REWARD', '', false);

  res.json(`Transaction from ${senderAddress} to ${recipientAddress} was added successfully`);
});

app.get("/nodes", (req: express.Request, res: express.Response) => {
  res.json(serialize(blockchain.nodes.toArray()));
});

app.post("/nodes", (req: express.Request, res: express.Response) => {
  const id = req.body.id;
  const url = new URL(req.body.url);

  if (!id || !url)  {
    res.json("Invalid parameters!");
    res.status(500);
    return;
  }

  const node = new Node(id, url);

  if (blockchain.register(node)) {
    res.json(`Registered node: ${node}`);
  } else {
    res.json(`Node ${node} already exists!`);
    res.status(500);
  }
});

app.put("/nodes/consensus", (req: express.Request, res: express.Response) => {
  // Fetch the state of the other nodes.
  const requests = blockchain.nodes.toArray().map(node => axios.get(`${node.url}blocks`));
  console.log('consensus: request-',requests)
  if (requests.length === 0) {
    res.json("There are nodes to sync with!");
    res.status(404);

    return;
  }

  axios.all(requests).then(axios.spread((...blockchains) => {
    if (blockchain.consensus(blockchains.map(res => deserialize<Block[]>(Block, res.data)))) {
      res.json(`Node ${nodeId} has reached a consensus on a new state.`);
    } else {
      res.json(`Node ${nodeId} hasn't reached a consensus on the existing state.`);
    }

    res.status(200);
    return;
  })).catch(err => {
    console.log(err);
    res.status(500);
    res.json(err);
    return;
  });

  res.status(500);
});

//get the voting options - Stored on the genesis block
app.get("/voting_options", (req: express.Request, res: express.Response) => {
  res.json(blockchain.blocks[0].prevBlock);
});

if (!module.parent) {
  app.listen(PORT);

  console.log(`\nWeb server started on port ${PORT}. Node ID is: ${nodeId}`);
}

//Allow a user to place his vote on the block chain
app.post("/vote", (req: express.Request, res: express.Response) => {
  const voterId = req.body.voterId;
  //const recipientAddress = req.body.recipientAddress;
  const value:string = req.body.votingValue;

  if (!voterId )  {
    res.json("Can't complete vote - Missing voter Id");
    res.status(500);
    return;
  }
  
  if (!value)  {
    res.json("Can't complete vote - you need to pick one voting optio");
    res.status(500);
    return;
  }

  //check if the submitted vote is a valid one by looking at the defenition in the genesis block
  if (!isValidVote(value)) {
    res.json("Invalid voting options. Valid options are "+Blockchain.GENESIS_BLOCK.prevBlock);
    res.status(500);
    return;
  }

  //check if the user has already voted
  if (!isValidVoter(voterId)) {
    res.json("Invalid Voter. It seems like voter has already took a vote");
    res.status(500);
    return;
  }

  //Add a VOTE transaction
  console.log('submitting transaction', voterId, value);
  blockchain.submitTransaction(voterId, '', 0, "VOTE", value, true);

  res.json(`Your vote for \'${value}\' was added successfully`);

  //transmit the transaction to all other nodes
  const requests = blockchain.nodes.toArray().map(node => axios.post(`${node.url}vote`,{voterId:voterId,votingValue:value}));
  if (requests.length === 0) {
    console.log('there are no other nodes to send the vote to');
    return;
  }

  axios.all(requests).then(axios.spread((...responses) => {
    res.status(200);
    return;
  })).catch(err => {
    console.log(err);
    res.status(500);
    res.json(err);
    return;
  });

  //Mark the end of voting, count the votes using the private key
  app.post("/end_of_voting", (req: any , res: express.Response) => {
    if (!req.files)
      return res.status(400).send('No files were uploaded.');
 
    // The name of the input field (i.e. "sampleFile") is used to retrieve the uploaded file
    let privateKey = req.files.keyfile.data.toString();

    console.log('Counting Votes......');
    var key =new NodeRSA({b: 2048});
    key.importKey(privateKey);
    let results:any = {}
    
    //   start counting votes using the private key for 
    for (let i = 1; i < blockchain.blocks.length; ++i) {
      for (let j=0;j<blockchain.blocks[i].transactions.length; j++) {
        if (blockchain.blocks[i].transactions[j].transactionType=="VOTE") {
          var decryptedData:any = key.decrypt(blockchain.blocks[i].transactions[j].transactionContent);
          var vote:string = JSON.parse(decryptedData).vote
          results[vote] = results[vote] ? results[vote] + 1 : 1;

        }
      }
    }

    let output="";
    for (var result in results) {
      output += result+':'+results[result] + ' ; ';
    }
    res.json('***** Voting results : '+output)
  });

});