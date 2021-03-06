/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { EndpointAppContextService } from '../../endpoint_app_context_services';
import {
  createMockEndpointAppContext,
  createMockEndpointAppContextServiceStartContract,
} from '../../mocks';
import { IRouter, KibanaRequest, RequestHandler } from 'kibana/server';
import { httpServerMock, httpServiceMock } from '../../../../../../../src/core/server/mocks';
import { registerTrustedAppsRoutes } from './index';
import {
  TRUSTED_APPS_CREATE_API,
  TRUSTED_APPS_DELETE_API,
  TRUSTED_APPS_LIST_API,
} from '../../../../common/endpoint/constants';
import {
  GetTrustedAppsListRequest,
  PostTrustedAppCreateRequest,
} from '../../../../common/endpoint/types';
import { xpackMocks } from '../../../../../../mocks';
import { ENDPOINT_TRUSTED_APPS_LIST_ID } from '../../../../../lists/common/constants';
import { EndpointAppContext } from '../../types';
import { ExceptionListClient, ListClient } from '../../../../../lists/server';
import { listMock } from '../../../../../lists/server/mocks';
import { ExceptionListItemSchema } from '../../../../../lists/common/schemas/response';
import { DeleteTrustedAppsRequestParams } from './types';
import { getExceptionListItemSchemaMock } from '../../../../../lists/common/schemas/response/exception_list_item_schema.mock';

type RequestHandlerContextWithLists = ReturnType<typeof xpackMocks.createRequestHandlerContext> & {
  lists?: {
    getListClient: () => jest.Mocked<ListClient>;
    getExceptionListClient: () => jest.Mocked<ExceptionListClient>;
  };
};

describe('when invoking endpoint trusted apps route handlers', () => {
  let routerMock: jest.Mocked<IRouter>;
  let endpointAppContextService: EndpointAppContextService;
  let context: RequestHandlerContextWithLists;
  let response: ReturnType<typeof httpServerMock.createResponseFactory>;
  let exceptionsListClient: jest.Mocked<ExceptionListClient>;
  let endpointAppContext: EndpointAppContext;

  beforeEach(() => {
    routerMock = httpServiceMock.createRouter();
    endpointAppContextService = new EndpointAppContextService();
    const startContract = createMockEndpointAppContextServiceStartContract();
    exceptionsListClient = listMock.getExceptionListClient() as jest.Mocked<ExceptionListClient>;
    endpointAppContextService.start(startContract);
    endpointAppContext = {
      ...createMockEndpointAppContext(),
      service: endpointAppContextService,
    };
    registerTrustedAppsRoutes(routerMock, endpointAppContext);

    // For use in individual API calls
    context = {
      ...xpackMocks.createRequestHandlerContext(),
      lists: {
        getListClient: jest.fn(),
        getExceptionListClient: jest.fn().mockReturnValue(exceptionsListClient),
      },
    };
    response = httpServerMock.createResponseFactory();
  });

  describe('when fetching list of trusted apps', () => {
    let routeHandler: RequestHandler<undefined, GetTrustedAppsListRequest>;
    const createListRequest = (page: number = 1, perPage: number = 20) => {
      return httpServerMock.createKibanaRequest<undefined, GetTrustedAppsListRequest>({
        path: TRUSTED_APPS_LIST_API,
        method: 'get',
        query: {
          page,
          per_page: perPage,
        },
      });
    };

    beforeEach(() => {
      // Get the registered List handler from the IRouter instance
      [, routeHandler] = routerMock.get.mock.calls.find(([{ path }]) =>
        path.startsWith(TRUSTED_APPS_LIST_API)
      )!;
    });

    it('should use ExceptionListClient from route handler context', async () => {
      const request = createListRequest();
      await routeHandler(context, request, response);
      expect(context.lists?.getExceptionListClient).toHaveBeenCalled();
    });

    it('should create the Trusted Apps List first', async () => {
      const request = createListRequest();
      await routeHandler(context, request, response);
      expect(exceptionsListClient.createTrustedAppsList).toHaveBeenCalled();
      expect(response.ok).toHaveBeenCalled();
    });

    it('should pass pagination query params to exception list service', async () => {
      const request = createListRequest(10, 100);
      const emptyResponse = {
        data: [],
        page: 10,
        per_page: 100,
        total: 0,
      };

      exceptionsListClient.findExceptionListItem.mockResolvedValue(emptyResponse);
      await routeHandler(context, request, response);

      expect(response.ok).toHaveBeenCalledWith({ body: emptyResponse });
      expect(exceptionsListClient.findExceptionListItem).toHaveBeenCalledWith({
        listId: ENDPOINT_TRUSTED_APPS_LIST_ID,
        page: 10,
        perPage: 100,
        filter: undefined,
        namespaceType: 'agnostic',
        sortField: 'name',
        sortOrder: 'asc',
      });
    });

    it('should log unexpected error if one occurs', async () => {
      exceptionsListClient.findExceptionListItem.mockImplementation(() => {
        throw new Error('expected error');
      });
      const request = createListRequest(10, 100);
      await routeHandler(context, request, response);
      expect(response.internalError).toHaveBeenCalled();
      expect(endpointAppContext.logFactory.get('trusted_apps').error).toHaveBeenCalled();
    });
  });

  describe('when creating a trusted app', () => {
    let routeHandler: RequestHandler<undefined, PostTrustedAppCreateRequest>;
    const createNewTrustedAppBody = (): PostTrustedAppCreateRequest => ({
      name: 'Some Anti-Virus App',
      description: 'this one is ok',
      os: 'windows',
      entries: [
        {
          field: 'process.path',
          type: 'match',
          operator: 'included',
          value: 'c:/programs files/Anti-Virus',
        },
      ],
    });
    const createPostRequest = () => {
      return httpServerMock.createKibanaRequest<undefined, PostTrustedAppCreateRequest>({
        path: TRUSTED_APPS_LIST_API,
        method: 'post',
        body: createNewTrustedAppBody(),
      });
    };

    beforeEach(() => {
      // Get the registered POST handler from the IRouter instance
      [, routeHandler] = routerMock.post.mock.calls.find(([{ path }]) =>
        path.startsWith(TRUSTED_APPS_CREATE_API)
      )!;

      // Mock the impelementation of `createExceptionListItem()` so that the return value
      // merges in the provided input
      exceptionsListClient.createExceptionListItem.mockImplementation(async (newExceptionItem) => {
        return ({
          ...getExceptionListItemSchemaMock(),
          ...newExceptionItem,
        } as unknown) as ExceptionListItemSchema;
      });
    });

    it('should use ExceptionListClient from route handler context', async () => {
      const request = createPostRequest();
      await routeHandler(context, request, response);
      expect(context.lists?.getExceptionListClient).toHaveBeenCalled();
    });

    it('should create trusted app list first', async () => {
      const request = createPostRequest();
      await routeHandler(context, request, response);
      expect(exceptionsListClient.createTrustedAppsList).toHaveBeenCalled();
      expect(response.ok).toHaveBeenCalled();
    });

    it('should map new trusted app item to an exception list item', async () => {
      const request = createPostRequest();
      await routeHandler(context, request, response);
      expect(exceptionsListClient.createExceptionListItem.mock.calls[0][0]).toEqual({
        _tags: ['os:windows'],
        comments: [],
        description: 'this one is ok',
        entries: [
          {
            field: 'process.path',
            operator: 'included',
            type: 'match',
            value: 'c:/programs files/Anti-Virus',
          },
        ],
        itemId: expect.stringMatching(/.*/),
        listId: 'endpoint_trusted_apps',
        meta: undefined,
        name: 'Some Anti-Virus App',
        namespaceType: 'agnostic',
        tags: [],
        type: 'simple',
      });
    });

    it('should return new trusted app item', async () => {
      const request = createPostRequest();
      await routeHandler(context, request, response);
      expect(response.ok.mock.calls[0][0]).toEqual({
        body: {
          data: {
            created_at: '2020-04-20T15:25:31.830Z',
            created_by: 'some user',
            description: 'this one is ok',
            entries: [
              {
                field: 'process.path',
                operator: 'included',
                type: 'match',
                value: 'c:/programs files/Anti-Virus',
              },
            ],
            id: '1',
            name: 'Some Anti-Virus App',
            os: 'windows',
          },
        },
      });
    });

    it('should log unexpected error if one occurs', async () => {
      exceptionsListClient.createExceptionListItem.mockImplementation(() => {
        throw new Error('expected error for create');
      });
      const request = createPostRequest();
      await routeHandler(context, request, response);
      expect(response.internalError).toHaveBeenCalled();
      expect(endpointAppContext.logFactory.get('trusted_apps').error).toHaveBeenCalled();
    });
  });

  describe('when deleting a trusted app', () => {
    let routeHandler: RequestHandler<DeleteTrustedAppsRequestParams>;
    let request: KibanaRequest<DeleteTrustedAppsRequestParams>;

    beforeEach(() => {
      [, routeHandler] = routerMock.delete.mock.calls.find(([{ path }]) =>
        path.startsWith(TRUSTED_APPS_DELETE_API)
      )!;

      request = httpServerMock.createKibanaRequest<DeleteTrustedAppsRequestParams>({
        path: TRUSTED_APPS_DELETE_API.replace('{id}', '123'),
        method: 'delete',
      });
    });

    it('should use ExceptionListClient from route handler context', async () => {
      await routeHandler(context, request, response);
      expect(context.lists?.getExceptionListClient).toHaveBeenCalled();
    });

    it('should return 200 on successful delete', async () => {
      await routeHandler(context, request, response);
      expect(exceptionsListClient.deleteExceptionListItem).toHaveBeenCalledWith({
        id: request.params.id,
        itemId: undefined,
        namespaceType: 'agnostic',
      });
      expect(response.ok).toHaveBeenCalled();
    });

    it('should return 404 if item does not exist', async () => {
      exceptionsListClient.deleteExceptionListItem.mockResolvedValueOnce(null);
      await routeHandler(context, request, response);
      expect(response.notFound).toHaveBeenCalled();
    });

    it('should log unexpected error if one occurs', async () => {
      exceptionsListClient.deleteExceptionListItem.mockImplementation(() => {
        throw new Error('expected error for delete');
      });
      await routeHandler(context, request, response);
      expect(response.internalError).toHaveBeenCalled();
      expect(endpointAppContext.logFactory.get('trusted_apps').error).toHaveBeenCalled();
    });
  });
});
