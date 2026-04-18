import { Kafka, logLevel, type Consumer, type Producer } from "kafkajs";

export function createKafkaClient(clientId: string, brokers: string) {
  return new Kafka({
    clientId,
    brokers: brokers.split(",").map((broker) => broker.trim()),
    logLevel: logLevel.NOTHING
  });
}

export async function connectProducer(producer: Producer) {
  await producer.connect();
  return producer;
}

export async function connectConsumer(consumer: Consumer, topics: string[]) {
  await consumer.connect();
  for (const topic of topics) {
    await consumer.subscribe({ topic, fromBeginning: false });
  }

  return consumer;
}
