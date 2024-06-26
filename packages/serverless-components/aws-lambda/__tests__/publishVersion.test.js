const { createComponent, createTmpDir } = require("../test-utils");

const {
  mockCreateFunctionPromise,
  mockPublishVersion,
  mockPublishVersionPromise,
  mockGetFunctionConfigurationPromise,
  mockUpdateFunctionCodePromise,
  mockUpdateFunctionConfigurationPromise
} = require("aws-sdk");

jest.mock("aws-sdk", () => require("../__mocks__/aws-sdk.mock"));

const mockIamRole = jest.fn();
jest.mock("@getjerry/aws-iam-role", () =>
  jest.fn(() => {
    const iamRole = mockIamRole;
    iamRole.init = () => {};
    iamRole.default = () => {};
    iamRole.context = {};
    return iamRole;
  })
);

describe("publishVersion", () => {
  let component;

  beforeEach(async () => {
    mockIamRole.mockResolvedValue({
      arn: "arn:aws:iam::123456789012:role/xyz"
    });
    mockCreateFunctionPromise.mockResolvedValueOnce({
      FunctionArn: "arn:aws:lambda:us-east-1:123456789012:function:my-func",
      CodeSha256: "LQT0VA="
    });

    component = await createComponent();
  });

  it("publishes new version of lambda that was created", async () => {
    mockGetFunctionConfigurationPromise.mockRejectedValueOnce({
      code: "ResourceNotFoundException"
    });
    mockGetFunctionConfigurationPromise.mockResolvedValue({
      FunctionName: "my-func",
      LastUpdateStatus: "Successful"
    });
    mockPublishVersionPromise.mockResolvedValueOnce({
      Version: "v2"
    });
    const tmpFolder = await createTmpDir();

    await component.default({
      code: tmpFolder,
      role: {
        name: "name",
        arn: "arn"
      }
    });

    const versionResult = await component.publishVersion();

    expect(mockPublishVersion).toBeCalledWith({
      CodeSha256: "LQT0VA="
    });

    expect(versionResult).toEqual({
      version: "v2"
    });
  });

  it("publishes new version of lambda that was updated", async () => {
    mockPublishVersionPromise.mockResolvedValue({
      Version: "v2"
    });
    mockGetFunctionConfigurationPromise.mockRejectedValueOnce({
      code: "ResourceNotFoundException"
    });
    mockGetFunctionConfigurationPromise.mockResolvedValue({
      FunctionName: "my-func",
      LastUpdateStatus: "Successful"
    });
    mockUpdateFunctionCodePromise.mockResolvedValueOnce({
      FunctionName: "my-func"
    });
    mockCreateFunctionPromise.mockResolvedValueOnce({
      CodeSha256: "LQT0VA="
    });
    mockUpdateFunctionConfigurationPromise.mockResolvedValueOnce({
      CodeSha256: "XYZ0VA="
    });

    const tmpFolder = await createTmpDir();

    await component.default({
      code: tmpFolder,
      role: {
        name: "name",
        arn: "arn"
      }
    });

    await component.default({
      code: tmpFolder,
      role: {
        name: "name",
        arn: "arn"
      }
    });

    const versionResult = await component.publishVersion();

    expect(mockPublishVersion).toBeCalledWith({
      CodeSha256: "XYZ0VA=" // compare against the hash received from the function update, *not* create
    });

    expect(versionResult).toEqual({
      version: "v2"
    });
  });
});
