pipeline {
    agent any 

    environment {
        AWS_DEFAULT_REGION = 'us-east-1'
        IMAGE_REPO_NAME    = 'interview-sample-app'
        IMAGE_TAG          = "${env.BUILD_ID}"
        SONAR_PROJECT_KEY  = 'AbhayVerma007_immverse.ai-assignment'
        SONAR_ORG_KEY      = 'abhayverma007-1'
        PRIVATE_APP_IP     = '10.0.2.183' 
    }

    options {
        timeout(time: 1, unit: 'HOURS') 
        disableConcurrentBuilds()     
    }

    stages {
        stage('Checkout Source') {
            steps {
                checkout scm
            }
        }

        stage('Docker Build Image') {
            steps {
                dir('app') {
                    sh 'docker build --no-cache -t $IMAGE_REPO_NAME:$IMAGE_TAG .'
                }
            }
        }

        stage('SonarQube Analysis & Quality Gate') {
            steps {
                withCredentials([string(credentialsId: 'sonar-cloud-token', variable: 'SONAR_TOKEN')]) {
                    dir('app') {
                        sh '''
                            docker run --rm \
                            -e SONAR_HOST_URL="https://sonarcloud.io" \
                            -e SONAR_TOKEN="$SONAR_TOKEN" \
                            -v "$(pwd):/usr/src" \
                            sonarsource/sonar-scanner-cli \
                            -Dsonar.projectKey=$SONAR_PROJECT_KEY \
                            -Dsonar.organization=$SONAR_ORG_KEY \
                            -Dsonar.sources=. \
                            -Dsonar.qualitygate.wait=true
                        '''
                    }
                }
            }
        }

        stage('Push to ECR Registry') {
            steps {
                withCredentials([string(credentialsId: 'aws-account-id', variable: 'AWS_ACCOUNT_ID')]) {
                    sh '''
                        aws ecr get-login-password --region $AWS_DEFAULT_REGION | \
                        docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com
                        
                        docker tag $IMAGE_REPO_NAME:$IMAGE_TAG $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/$IMAGE_REPO_NAME:$IMAGE_TAG
                        docker push $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/$IMAGE_REPO_NAME:$IMAGE_TAG
                    '''
                }
            }
        }

        stage('Deploy to Private EC2') {
            steps {
                sshagent(credentials: ['immverse-ssh-key']) {
                    withCredentials([
                        string(credentialsId: 'jenkins-url', variable: 'JENKINS_URL'),
                        string(credentialsId: 'jenkins-user', variable: 'JENKINS_USER'),
                        string(credentialsId: 'jenkins-token', variable: 'JENKINS_TOKEN'),
                        string(credentialsId: 'aws-account-id', variable: 'AWS_ACCOUNT_ID')
                    ]) {
                        sh '''
                            ssh -o StrictHostKeyChecking=no ubuntu@$PRIVATE_APP_IP << EOF
                            set -e
                            
                            aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com
                            
                            docker stop interview-production-app || true
                            docker rm interview-production-app || true
                            
                            docker run -d \
                            --name interview-production-app \
                            -p 3000:3000 \
                            -e JENKINS_URL="$JENKINS_URL" \
                            -e JENKINS_USER="$JENKINS_USER" \
                            -e JENKINS_TOKEN="$JENKINS_TOKEN" \
                            -e JOB_NAME="immverse-production-pipeline" \
                            --restart always \
                            $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/$IMAGE_REPO_NAME:$IMAGE_TAG
EOF
                        '''
                    }
                }
            }
        }
    }

    // The post block must be outside 'stages' and inside 'pipeline'
    post {
        always {
            script {
                withCredentials([string(credentialsId: 'aws-account-id', variable: 'AWS_ACCOUNT_ID')]) {
                    sh 'docker rmi $IMAGE_REPO_NAME:$IMAGE_TAG || true'
                    sh 'docker rmi $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/$IMAGE_REPO_NAME:$IMAGE_TAG || true'
                }
            }
        }
        success {
            echo 'Pipeline completed successfully.'
        }
        failure {
            slackSend(
                color: 'danger', 
                channel: '#eks-alerts',
                tokenCredentialId: 'slack-token',
                message: "🚨 *Pipeline Failed:* ${env.JOB_NAME} [Build #${env.BUILD_NUMBER}]\nReview the Jenkins dashboard logs here: ${env.BUILD_URL}"
            )
        }
    }
}