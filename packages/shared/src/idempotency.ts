import { Prisma } from "@prisma/client";

export async function markEventProcessedIfNew(
  tx: Prisma.TransactionClient,
  eventId: string,
  consumerGroup: string
) {
  try {
    await tx.processedEvent.create({
      data: {
        eventId,
        consumerGroup
      }
    });
    return true;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return false;
    }

    throw error;
  }
}
