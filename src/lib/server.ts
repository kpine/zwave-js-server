import ws from "ws";
import type WebSocket from "ws";
import type { Driver } from "zwave-js";
import { EventForwarder } from "./forward";
import type * as OutgoingMessages from "./outgoing_message";
import { IncomingMessage } from "./incoming_message";
import { dumpState } from "./state";
import { Server as HttpServer, createServer } from "http";
import { once } from "events";
import { version } from "./const";
import { NodeMessageHandler } from "./node/message_handler";
import { ControllerMessageHandler } from "./controller/message_handler";
import { IncomingMessageController } from "./controller/incoming_message";
import { BaseError, ErrorCode, UnknownCommandError } from "./error";
import { Instance } from "./instance";
import { IncomingMessageNode } from "./node/incoming_message";

class Client {
  public receiveEvents = false;
  private _outstandingPing = false;

  private instanceHandlers: Record<
    Instance,
    (
      message: IncomingMessage
    ) => Promise<OutgoingMessages.OutgoingResultMessageSuccess["result"]>
  > = {
    [Instance.controller]: (message) =>
      ControllerMessageHandler.handle(
        message as IncomingMessageController,
        this.driver
      ),
    [Instance.driver]: () => {
      throw new Error("Driver handler not implemented.");
    },
    [Instance.node]: (message) =>
      NodeMessageHandler.handle(message as IncomingMessageNode, this.driver),
  };

  constructor(private socket: WebSocket, private driver: Driver) {
    socket.on("pong", () => {
      this._outstandingPing = false;
    });
    socket.on("message", (data: string) => this.receiveMessage(data));
  }

  get isConnected(): boolean {
    return this.socket.readyState === this.socket.OPEN;
  }

  async receiveMessage(data: string) {
    let msg: IncomingMessage;
    try {
      msg = JSON.parse(data);
    } catch (err) {
      // We don't have the message ID. Just close it.
      this.socket.close();
      return;
    }

    try {
      if (msg.command === "start_listening") {
        this.sendResultSuccess(msg.messageId, {
          state: dumpState(this.driver),
        });
        this.receiveEvents = true;
        return;
      }

      const [instance] = msg.command.split(".");
      if (this.instanceHandlers[instance]) {
        return this.sendResultSuccess(
          msg.messageId,
          await this.instanceHandlers[instance](msg)
        );
      }

      throw new UnknownCommandError(msg.command);
    } catch (err: unknown) {
      if (err instanceof BaseError) {
        console.error("Message error", err);
        return this.sendResultError(msg.messageId, err.errorCode);
      }

      console.error("Unexpected error", err);
      this.sendResultError(msg.messageId, ErrorCode.unknownError);
    }
  }

  sendVersion() {
    this.sendData({
      type: "version",
      driverVersion: "TBD",
      serverVersion: version,
      homeId: this.driver.controller.homeId,
    });
  }

  sendResultSuccess(
    messageId: string,
    result: OutgoingMessages.OutgoingResultMessageSuccess["result"]
  ) {
    this.sendData({
      type: "result",
      success: true,
      messageId,
      result,
    });
  }

  sendResultError(messageId: string, errorCode: string) {
    this.sendData({
      type: "result",
      success: false,
      messageId,
      errorCode,
    });
  }

  sendEvent(event: OutgoingMessages.OutgoingEvent) {
    this.sendData({
      type: "event",
      event,
    });
  }

  sendData(data: OutgoingMessages.OutgoingMessage) {
    this.socket.send(JSON.stringify(data));
  }

  checkAlive() {
    if (this._outstandingPing) {
      this.disconnect();
      return;
    }
    this._outstandingPing = true;
    this.socket.ping();
  }

  disconnect() {
    this.socket.close();
  }
}
class Clients {
  private clients: Array<Client> = [];
  private pingInterval?: NodeJS.Timeout;
  private eventForwarder?: EventForwarder;
  private cleanupScheduled = false;

  constructor(private driver: Driver) {}

  addSocket(socket: WebSocket) {
    console.debug("New client");
    const client = new Client(socket, this.driver);
    socket.on("close", () => {
      console.info("Client disconnected");
      this.scheduleClientCleanup();
    });
    client.sendVersion();
    this.clients.push(client);

    if (this.pingInterval === undefined) {
      this.pingInterval = setInterval(() => {
        const newClients = [];

        for (const client of this.clients) {
          if (client.isConnected) {
            newClients.push(client);
          } else {
            client.disconnect();
          }
        }

        this.clients = newClients;
      }, 30000);
    }

    if (this.eventForwarder === undefined) {
      this.eventForwarder = new EventForwarder(this.driver, (data) => {
        for (const client of this.clients) {
          if (client.receiveEvents && client.isConnected) {
            client.sendEvent(data);
          }
        }
      });
      this.eventForwarder.start();
    }
  }

  private scheduleClientCleanup() {
    if (this.cleanupScheduled) {
      return;
    }
    this.cleanupScheduled = true;
    setTimeout(() => this.cleanupClients(), 0);
  }

  private cleanupClients() {
    this.cleanupScheduled = false;
    this.clients = this.clients.filter((cl) => cl.isConnected);
  }

  disconnect() {
    if (this.pingInterval !== undefined) {
      clearInterval(this.pingInterval);
    }
    this.pingInterval = undefined;
    this.clients.forEach((client) => client.disconnect());
    this.clients = [];
  }
}
interface ZwavejsServerOptions {
  port: number;
}

export class ZwavejsServer {
  private server?: HttpServer;
  private wsServer?: ws.Server;
  private sockets?: Clients;

  constructor(private driver: Driver, private options: ZwavejsServerOptions) {}

  async start() {
    this.server = createServer();
    this.wsServer = new ws.Server({ server: this.server });
    this.sockets = new Clients(this.driver);
    this.wsServer.on("connection", (socket) => this.sockets!.addSocket(socket));

    this.server.listen(this.options.port);
    await once(this.server, "listening");
  }

  async destroy() {
    if (this.sockets) {
      this.sockets.disconnect();
    }
    if (this.server) {
      this.server.close();
      await once(this.server, "close");
    }
  }
}