import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { SampleQueueService } from './sample-queue.service';

describe('SampleQueueService', () => {
  let service: SampleQueueService;
  let mockQueue: { add: jest.Mock };

  beforeEach(async () => {
    mockQueue = {
      add: jest.fn().mockResolvedValue({
        id: 'job-123',
        name: 'example-job',
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SampleQueueService,
        {
          provide: getQueueToken('sample-queue'),
          useValue: mockQueue,
        },
      ],
    }).compile();

    service = module.get<SampleQueueService>(SampleQueueService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should enqueue an example job', async () => {
    const data = { message: 'test payload' };
    const result = await service.addExampleJob(data);

    expect(mockQueue.add).toHaveBeenCalledWith('example-job', data, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000,
      },
    });
    expect(result).toEqual({
      jobId: 'job-123',
      name: 'example-job',
      status: 'enqueued',
    });
  });
});
