"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.run = run;
const core_1 = require("@actions/core");
const github_1 = require("@actions/github");
const GITHUB_ACTIONS_BOT = "github-actions[bot]";
const repoToken = (0, core_1.getInput)("repo-token", { required: true });
const titleRegex = new RegExp((0, core_1.getInput)("title-regex", {
    required: true,
}));
const onFailedRegexFailAction = (0, core_1.getInput)("on-failed-regex-fail-action") === "true";
const onFailedRegexCreateReview = (0, core_1.getInput)("on-failed-regex-create-review") === "true";
const onFailedRegexRequestChanges = (0, core_1.getInput)("on-failed-regex-request-changes") === "true";
const onFailedRegexComment = (0, core_1.getInput)("on-failed-regex-comment");
const onSucceededRegexDismissReviewComment = (0, core_1.getInput)("on-succeeded-regex-dismiss-review-comment");
const onSucceededRegexMinimizeComment = (0, core_1.getInput)("on-succeeded-regex-minimize-comment") === "true";
const onMinimizeCommentReason = (0, core_1.getInput)("on-minimize-comment-reason") || "resolved";
const octokit = (0, github_1.getOctokit)(repoToken);
async function run() {
    const githubContext = github_1.context;
    const pullRequest = githubContext.issue;
    const title = githubContext.payload.pull_request?.title ?? "";
    const comment = onFailedRegexComment.replace("%regex%", titleRegex.source);
    (0, core_1.debug)(`Title Regex: ${titleRegex.source}`);
    (0, core_1.debug)(`Title: ${title}`);
    const titleMatchesRegex = titleRegex.test(title);
    if (!titleMatchesRegex) {
        if (onFailedRegexCreateReview) {
            await createOrUpdateReview(comment, pullRequest);
        }
        if (onFailedRegexFailAction) {
            (0, core_1.setFailed)(comment);
        }
    }
    else {
        if (onFailedRegexCreateReview) {
            console.log(`PR title matches regex, dismissing any existing reviews`);
            await dismissReview(pullRequest);
            if (onSucceededRegexMinimizeComment) {
                console.log(`Attempting to minimize reviews and comments`);
                await minimizeExistingComments(pullRequest);
            }
        }
    }
}
const createOrUpdateReview = async (comment, pullRequest) => {
    const review = await getExistingReview(pullRequest);
    if (review === undefined) {
        await octokit.rest.pulls.createReview({
            owner: pullRequest.owner,
            repo: pullRequest.repo,
            pull_number: pullRequest.number,
            body: comment,
            event: onFailedRegexRequestChanges ? "REQUEST_CHANGES" : "COMMENT",
        });
    }
    else {
        await octokit.rest.pulls.updateReview({
            owner: pullRequest.owner,
            repo: pullRequest.repo,
            pull_number: pullRequest.number,
            review_id: review.id,
            body: comment,
        });
    }
};
const isGitHubActionUser = (login) => {
    return login === GITHUB_ACTIONS_BOT;
};
const getExistingReview = async (pullRequest) => {
    const reviews = await octokit.rest.pulls.listReviews({
        owner: pullRequest.owner,
        repo: pullRequest.repo,
        pull_number: pullRequest.number,
    });
    return reviews.data.find((review) => review.user && isGitHubActionUser(review.user.login));
};
const dismissReview = async (pullRequest) => {
    const review = await getExistingReview(pullRequest);
    if (review) {
        console.log(`Found existing review with ID: ${review.id}, state: ${review.state}`);
        if (review.state === "APPROVED" || review.state === "CHANGES_REQUESTED") {
            console.log(`Dismissing review with ID: ${review.id}`);
            try {
                await octokit.rest.pulls.dismissReview({
                    owner: pullRequest.owner,
                    repo: pullRequest.repo,
                    pull_number: pullRequest.number,
                    review_id: review.id,
                    message: onSucceededRegexDismissReviewComment,
                });
                console.log(`Successfully dismissed review with ID: ${review.id}`);
            }
            catch (error) {
                console.log(`Error dismissing review: ${error instanceof Error ? error.message : String(error)}`);
                try {
                    console.log(`Creating a new comment since review can't be dismissed`);
                    await octokit.rest.pulls.createReview({
                        owner: pullRequest.owner,
                        repo: pullRequest.repo,
                        pull_number: pullRequest.number,
                        body: onSucceededRegexDismissReviewComment,
                        event: "COMMENT",
                    });
                }
                catch (commentError) {
                    console.log(`Error creating comment: ${commentError instanceof Error ? commentError.message : String(commentError)}`);
                }
            }
        }
        else {
            console.log(`Review state is ${review.state}, creating a new comment instead of dismissing`);
            await octokit.rest.pulls.createReview({
                owner: pullRequest.owner,
                repo: pullRequest.repo,
                pull_number: pullRequest.number,
                body: onSucceededRegexDismissReviewComment,
                event: "COMMENT",
            });
        }
    }
    else {
        console.log(`No review found to dismiss for PR #${pullRequest.number}`);
    }
};
const getExistingComments = async (pullRequest) => {
    console.log(`Getting comments for PR #${pullRequest.number}`);
    const reviewComments = await octokit.rest.pulls.listReviewComments({
        owner: pullRequest.owner,
        repo: pullRequest.repo,
        pull_number: pullRequest.number,
    });
    console.log(`Found ${reviewComments.data.length} review comments`);
    const issueComments = await octokit.rest.issues.listComments({
        owner: pullRequest.owner,
        repo: pullRequest.repo,
        issue_number: pullRequest.number,
    });
    console.log(`Found ${issueComments.data.length} issue comments`);
    const allComments = [...reviewComments.data, ...issueComments.data];
    console.log(`Filtering comments created by the bot`);
    const bot_comments = allComments.filter((comment) => {
        return comment.user !== null && isGitHubActionUser(comment.user.login);
    });
    console.log(`Found ${bot_comments.length} comments created by the bot`);
    return bot_comments;
};
const getCommentNodeId = async (commentDatabaseId, pullRequest) => {
    try {
        const { repository } = await octokit.graphql(`
      query GetCommentNodeId($owner: String!, $repo: String!, $prNumber: Int!, $commentDatabaseId: Int!) {
        repository(owner: $owner, name: $repo) {
          issueOrPullRequest(number: $prNumber) {
            ... on Issue {
              comments(first: 1, where: {databaseId: $commentDatabaseId}) {
                nodes {
                  id
                }
              }
            }
            ... on PullRequest {
              comments(first: 1, where: {databaseId: $commentDatabaseId}) {
                nodes {
                  id
                }
              }
            }
          }
        }
      }
    `, {
            owner: pullRequest.owner,
            repo: pullRequest.repo,
            prNumber: pullRequest.number,
            commentDatabaseId: commentDatabaseId,
        });
        const issueOrPR = repository?.issueOrPullRequest;
        if (!issueOrPR) {
            console.log(`No issue or PR found for number ${pullRequest.number}`);
            return null;
        }
        const comments = issueOrPR.comments.nodes;
        if (comments && comments.length > 0) {
            if (comments.length > 1) {
                console.log(`Found multiple comments with the same database ID: ${commentDatabaseId}`);
            }
            console.log(`Found comment with node ID: ${comments[0].id}`);
            return comments[0].id;
        }
        console.log(`No comments found with database ID: ${commentDatabaseId}`);
        return null;
    }
    catch (error) {
        console.log(`Error fetching comment node ID: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
};
const getReviewNodeId = async (reviewDatabaseId, pullRequest) => {
    try {
        const { repository } = await octokit.graphql(`
      query GetReviewNodeId($owner: String!, $repo: String!, $prNumber: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $prNumber) {
            reviews(first: 100) {
              nodes {
                id
                databaseId
              }
            }
          }
        }
      }
    `, {
            owner: pullRequest.owner,
            repo: pullRequest.repo,
            prNumber: pullRequest.number,
        });
        const pullRequestObj = repository?.pullRequest;
        if (!pullRequestObj) {
            console.log(`No PR found for number ${pullRequest.number}`);
            return null;
        }
        const review = pullRequestObj.reviews.nodes.find(node => node.databaseId === reviewDatabaseId);
        if (review) {
            console.log(`Found review with node ID: ${review.id}`);
            return review.id;
        }
        console.log(`No reviews found with database ID: ${reviewDatabaseId}`);
        return null;
    }
    catch (error) {
        console.log(`Error fetching review node ID: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
};
const minimizeExistingComments = async (pullRequest) => {
    console.log(`Minimizing existing content on PR #${pullRequest.number}`);
    const review = await getExistingReview(pullRequest);
    if (review) {
        console.log(`Found existing review with ID: ${review.id}`);
        const reviewNodeId = await getReviewNodeId(review.id, pullRequest);
        if (reviewNodeId) {
            await minimizeReview(reviewNodeId, pullRequest);
        }
    }
    else {
        console.log('No existing reviews found to minimize');
    }
    const comments = await getExistingComments(pullRequest);
    for (const comment of comments) {
        console.log(`Processing comment with database ID: ${comment.id}`);
        const nodeId = await getCommentNodeId(comment.id, pullRequest);
        if (nodeId) {
            await minimizeComment(nodeId, pullRequest);
        }
    }
};
const minimizeComment = async (commentNodeId, pullRequest) => {
    try {
        console.log(`Minimizing comment with node ID: ${commentNodeId}`);
        const { minimizeComment: result } = await octokit.graphql(`
      mutation MinimizeComment($input: MinimizeCommentInput!) {
        minimizeComment(input: $input) {
          minimizedComment {
            isMinimized
            minimizedReason
          }
        }
      }
    `, {
            input: {
                subjectId: commentNodeId,
                classifier: onMinimizeCommentReason,
                clientMutationId: `pr-lint-action-${pullRequest.number}-${Date.now()}`,
            },
        });
        console.log(`Comment minimized successfully: ${JSON.stringify(result)}`);
    }
    catch (error) {
        console.log(`Failed to minimize comment: ${error instanceof Error ? error.message : String(error)}`);
        if (error instanceof Error && error.stack) {
            console.log(`Stack trace: ${error.stack}`);
        }
    }
};
const minimizeReview = async (reviewNodeId, pullRequest) => {
    try {
        console.log(`Minimizing review with node ID: ${reviewNodeId}`);
        await octokit.graphql(`
      mutation MinimizeComment($input: MinimizeCommentInput!) {
        minimizeComment(input: $input) {
          minimizedComment {
            isMinimized
            minimizedReason
          }
        }
      }
    `, {
            input: {
                subjectId: reviewNodeId,
                classifier: onMinimizeCommentReason,
                clientMutationId: `pr-lint-action-review-${pullRequest.number}-${Date.now()}`,
            },
        });
        console.log(`Review minimized successfully`);
    }
    catch (error) {
        console.log(`Failed to minimize review: ${error instanceof Error ? error.message : String(error)}`);
        if (error instanceof Error && error.stack) {
            console.log(`Stack trace: ${error.stack}`);
        }
        try {
            console.log(`Falling back to dismissing the review`);
            const review = await getExistingReview(pullRequest);
            if (review) {
                await octokit.rest.pulls.dismissReview({
                    owner: pullRequest.owner,
                    repo: pullRequest.repo,
                    pull_number: pullRequest.number,
                    review_id: review.id,
                    message: onSucceededRegexDismissReviewComment,
                });
                console.log(`Review dismissed successfully as fallback`);
            }
        }
        catch (fallbackError) {
            console.log(`Fallback also failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
        }
    }
};
