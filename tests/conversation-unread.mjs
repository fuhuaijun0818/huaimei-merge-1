import assert from 'node:assert/strict';
import {createConversationReadState} from '../src/conversation-unread.js';
const reads=createConversationReadState();const a={id:'a',messages:[{id:'a1',from:'customer'},{id:'a2',from:'ai'}]},b={id:'b',messages:[{id:'b1',from:'customer'}]};
assert.equal(reads.unread(a),2);assert.equal(reads.unread(b),1);reads.markRead(a);assert.equal(reads.unread(a),0);assert.equal(reads.unread(b),1);
a.messages.push({id:'a3',from:'ai'});assert.equal(reads.unread(a),1);assert.equal(reads.unread(structuredClone(a)),1);a.messages.push({id:'sys',from:'system'});assert.equal(reads.unread(a),1);reads.markRead(a);assert.equal(reads.unread(a),0);console.log('PASS separate visitor unread counts, read clearing, later AI replies, repeated snapshots, system notices');
