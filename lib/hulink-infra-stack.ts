import * as cdk from "aws-cdk-lib"
import * as ec2 from "aws-cdk-lib/aws-ec2"
import * as ecr from "aws-cdk-lib/aws-ecr"
import * as ecs from "aws-cdk-lib/aws-ecs"
import * as ecs_patterns from "aws-cdk-lib/aws-ecs-patterns"
import * as rds from "aws-cdk-lib/aws-rds"
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager"
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'

import {Construct} from "constructs"

export class HulinkInfraStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props)

        // ECR
        const repository = ecr.Repository.fromRepositoryName(this, 'HulinkRepository', process.env['ECR_REPOSITORY_NAME']!);

        // VPC
        const vpc = new ec2.Vpc(this, "HulinkVpc", {
            maxAzs: 2,
            natGateways: 1
        })

        // VPCエンドポイント
        vpc.addInterfaceEndpoint('ECREndpoint', {
            service: ec2.InterfaceVpcEndpointAwsService.ECR,
        });

        vpc.addInterfaceEndpoint('ECRDockerEndpoint', {
            service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
        });

        vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
            service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
        });

        // ECSクラスター
        const cluster = new ecs.Cluster(this, "HulinkCluster", {
            vpc: vpc
        })

        // セキュリティグループ
        const dbSecurityGroup = new ec2.SecurityGroup(this, 'DBSecurityGroup', {
            vpc,
            allowAllOutbound: true,
        });

        const appSecurityGroup = new ec2.SecurityGroup(this, 'AppSecurityGroup', {
            vpc,
            allowAllOutbound: true,
        });

        dbSecurityGroup.addIngressRule(appSecurityGroup, ec2.Port.tcp(5432), 'Allow PostgreSQL access from Fargate');

        // RDS
        const dbCredentials = new secretsmanager.Secret(this, 'DBCredentials', {
            generateSecretString: {
                secretStringTemplate: JSON.stringify({username: process.env['DATABASE_USERNAME']}),
                generateStringKey: 'password',
                excludePunctuation: true,
            }
        });

        const database = new rds.DatabaseInstance(this, 'Database', {
            databaseName: 'hulink',
            engine: rds.DatabaseInstanceEngine.postgres({version: rds.PostgresEngineVersion.VER_13}),
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
            credentials: rds.Credentials.fromSecret(dbCredentials),
            vpc,
            vpcSubnets: {
                subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
            },
            securityGroups: [dbSecurityGroup],
        });

        // SecretsManager
        const googleCredentials = secretsmanager.Secret.fromSecretNameV2(this, 'GoogleCredentials', process.env['SECRET_NAME']!);

        // DATABASE_URLの作成
        const databaseUrlSecret = new secretsmanager.Secret(this, 'DatabaseUrlSecret', {
            secretObjectValue: {
                url: cdk.SecretValue.unsafePlainText(
                    `postgresql://${database.secret?.secretValueFromJson('username').unsafeUnwrap()}:${database.secret?.secretValueFromJson('password').unsafeUnwrap()}@${database.dbInstanceEndpointAddress}:${database.dbInstanceEndpointPort}/hulink?schema=public`
                )
            },
        });

        // アプリドメイン名
        const domainName = process.env['DOMAIN_NAME']!
        const fullDomainName = `${domainName}`

        // Route 53 ホストゾーン
        const hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
            domainName: domainName
        })

        // ACM証明書
        const certificate = new acm.Certificate(this, 'Certificate', {
            domainName: fullDomainName,
            validation: acm.CertificateValidation.fromDns(hostedZone),
        })

        // Fargate
        const backendApp = new ecs_patterns.ApplicationLoadBalancedFargateService(this, "HulinkFargateService", {
            cluster: cluster,
            cpu: 256,
            desiredCount: 3,
            taskImageOptions: {
                image: ecs.ContainerImage.fromEcrRepository(repository),
                containerPort: 80,
                logDriver: new ecs.AwsLogDriver({
                    streamPrefix: 'hulink-app',
                }),
                environment: {
                    APP_ENV: 'production',
                    APP_PORT: '80',
                    LOG_PRETTY_PRINT: 'false',
                    LOG_LEVEL: 'info',
                    AUTH_ENABLED: 'true',
                    GOOGLE_APPLICATION_CREDENTIALS: '/app/service-account.json'
                },
                secrets: {
                    DATABASE_URL: ecs.Secret.fromSecretsManager(databaseUrlSecret, 'url'),
                    GOOGLE_APPLICATION_CREDENTIALS_CONTENT: ecs.Secret.fromSecretsManager(googleCredentials),
                },
            },
            memoryLimitMiB: 1024,
            publicLoadBalancer: true,
            healthCheckGracePeriod: cdk.Duration.seconds(60),
            securityGroups: [appSecurityGroup],
            certificate: certificate,
            redirectHTTP: true,
            domainName: fullDomainName,
            domainZone: hostedZone,
        })

        // スケーリングの設定
        const scaling = backendApp.service.autoScaleTaskCount({
            minCapacity: 2,
            maxCapacity: 5,
        });

        // healthCheck
        backendApp.targetGroup.configureHealthCheck({
            path: '/v1/health',
            healthyThresholdCount: 2,
            unhealthyThresholdCount: 3,
            interval: cdk.Duration.seconds(30),
        })

        scaling.scaleOnCpuUtilization('CpuScaling', {
            targetUtilizationPercent: 70,
            scaleInCooldown: cdk.Duration.seconds(60),
            scaleOutCooldown: cdk.Duration.seconds(60)
        });
    }
}
