import { ApiEventLogSchema, CachedTaskSchema } from "@trigger.dev/internal";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { ClientApi, ClientApiError } from "../clientApi.server";
import { workerQueue } from "../worker.server";

export class ResumeTaskService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string, output?: any) {
    const task = await this.#prismaClient.task.findUniqueOrThrow({
      where: { id },
      include: {
        execution: {
          include: {
            jobInstance: {
              include: {
                endpoint: true,
                job: true,
              },
            },
            environment: true,
            eventLog: true,
            organization: true,
            tasks: {
              where: {
                status: {
                  in: ["COMPLETED"],
                },
              },
            },
          },
        },
      },
    });

    const { execution } = task;

    const updatedTask = await this.#prismaClient.task.update({
      where: {
        id: task.id,
      },
      data: {
        status: task.noop || output ? "COMPLETED" : "RUNNING",
        completedAt: task.noop ? new Date() : undefined,
        output: task.noop ? undefined : output,
      },
    });

    const client = new ClientApi(
      execution.environment.apiKey,
      execution.jobInstance.endpoint.url
    );

    const event = ApiEventLogSchema.parse(execution.eventLog);

    try {
      const results = await client.executeJob({
        event,
        job: {
          id: execution.jobInstance.job.slug,
          version: execution.jobInstance.version,
        },
        context: {
          id: execution.id,
          environment: execution.environment.slug,
          organization: execution.organization.slug,
          isTest: execution.isTest,
          version: execution.jobInstance.version,
          startedAt: execution.startedAt ?? new Date(),
        },
        tasks: [execution.tasks, updatedTask]
          .flat()
          .map((t) => CachedTaskSchema.parse(t)),
      });

      if (results.completed) {
        await this.#prismaClient.execution.update({
          where: { id: execution.id },
          data: {
            completedAt: new Date(),
            status: "SUCCESS",
            output: results.output ?? undefined,
          },
        });
      }

      if (results.task) {
        await workerQueue.enqueue(
          "resumeTask",
          {
            id: results.task.id,
          },
          { runAt: results.task.delayUntil ?? undefined }
        );

        return;
      }
    } catch (error) {
      if (error instanceof ClientApiError) {
        await this.#prismaClient.execution.update({
          where: { id },
          data: {
            completedAt: new Date(),
            status: "FAILURE",
            output: { message: error.message, stack: error.stack },
          },
        });
      }
    }
  }
}
